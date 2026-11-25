import { createHash } from "node:crypto";
import { canonicalJson, type ModelProvider, type SearchProvider, type ToolDefinition } from "@harness/harness";
import {
  PluginContractError,
  type Disposer, type ModelRoute, type ModelsSeam, type PluginContext, type PluginUse, type RunContext, type SandboxDriver, type SandboxSeam, type SeamKey,
  type Seams, type SearchSeam, type ToolsSeam,
} from "./plugin.ts";

export type PluginState = "declared" | "configured" | "waiting" | "active" | "disposing" | "disposed" | "failed";

/** What `harness plugins` prints, and what a run can record: which plugins made it, and with what config. */
export type PluginReport = {
  name: string;
  version: string;
  state: PluginState;
  provides: SeamKey[];
  requires: SeamKey[];
  /** SHA-256 of the parsed config. Secrets are never in config, so this is safe to log. */
  configSha256: string;
  error?: string;
};

export type BootOptions = {
  /** Where `ctx.secret` reads from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Told about a disposer that threw. Teardown carries on. */
  onDisposeError?: (plugin: string, error: unknown) => void;
};

type Owned = { plugin: string; dispose: Disposer };

class Registries implements Seams {
  private readonly routes: ModelRoute[] = [];
  private readonly built = new Map<string, ModelProvider>();
  private sandboxFactory: SandboxDriver | undefined;
  private sandboxOwner: string | undefined;
  private readonly searchers = new Map<string, SearchProvider>();
  private readonly toolList = new Map<string, ToolDefinition>();
  /** Which plugin is applying right now, so a registration knows its owner. */
  current = "";

  readonly models: ModelsSeam = {
    register: (route) => {
      this.routes.push(route);
    },
    has: (model) => this.routes.some((r) => r.handles(model)),
    get: (model) => {
      const route = this.routes.find((r) => r.handles(model));
      if (!route) throw new PluginContractError(`No plugin provides the model "${model}". Routes: ${this.routes.map((r) => r.name).join(", ") || "none"}.`);
      let provider = this.built.get(route.name);
      if (!provider) {
        provider = route.create(model);
        this.built.set(route.name, provider);
      }
      return provider;
    },
  };

  readonly sandbox: SandboxSeam = {
    provide: (factory) => {
      if (this.sandboxFactory) throw new PluginContractError(`The sandbox seam has one provider, and "${this.sandboxOwner}" already provides it.`);
      this.sandboxFactory = factory;
      this.sandboxOwner = this.current;
    },
    get: () => this.sandboxFactory,
  };

  readonly search: SearchSeam = {
    register: (name, provider) => {
      if (this.searchers.has(name)) throw new PluginContractError(`Two search providers are named "${name}".`);
      this.searchers.set(name, provider);
    },
    get: (name) => (name ? this.searchers.get(name) : this.searchers.values().next().value),
    names: () => [...this.searchers.keys()],
  };

  readonly tools: ToolsSeam = {
    register: (tool) => {
      if (this.toolList.has(tool.name)) throw new PluginContractError(`Two tools are named "${tool.name}".`);
      this.toolList.set(tool.name, { plugin: this.current, ...tool });
    },
    list: () => [...this.toolList.values()],
  };

  /** Whether anything was registered into a seam, for checking that a required seam is really there. */
  filled(key: SeamKey): boolean {
    if (key === "models") return this.routes.length > 0;
    if (key === "sandbox") return this.sandboxFactory !== undefined;
    if (key === "search") return this.searchers.size > 0;
    return this.toolList.size > 0;
  }
}

/** A running set of plugins. Built by `boot`; everything it holds is undone by `dispose`. */
export class Harness {
  private readonly runSetups: { plugin: string; setup: (run: RunContext) => void | Promise<void> }[] = [];
  private disposed = false;

  constructor(
    private readonly seams: Registries,
    private readonly effects: Owned[],
    readonly plugins: readonly PluginReport[],
    private readonly options: BootOptions,
  ) {}

  /** @internal */
  addRunSetup(plugin: string, setup: (run: RunContext) => void | Promise<void>): void {
    this.runSetups.push({ plugin, setup });
  }

  model(model: string): ModelProvider {
    return this.seams.models.get(model);
  }
  hasModel(model: string): boolean {
    return this.seams.models.has(model);
  }
  /** The sandbox driver, if a plugin provides one. */
  get sandbox(): SandboxDriver | undefined {
    return this.seams.sandbox.get();
  }
  search(name?: string): SearchProvider | undefined {
    return this.seams.search.get(name);
  }
  get tools(): ToolDefinition[] {
    return this.seams.tools.list();
  }

  /** Opens a run's scope: every plugin's `onRun` runs, and what they set up is undone by the returned function. */
  async openRun(runId: string): Promise<() => Promise<void>> {
    const owned: Owned[] = [];
    for (const { plugin, setup } of this.runSetups) {
      await setup({
        runId,
        effect: (work) => {
          owned.push({ plugin, dispose: () => undefined });
          const slot = owned.length - 1;
          return void Promise.resolve(work()).then((dispose) => {
            owned[slot] = { plugin, dispose };
          });
        },
      });
    }
    return () => unwind(owned, this.options);
  }

  /** Unwinds every plugin's effects, newest first. A disposer that throws is reported and the rest still run. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await unwind(this.effects, this.options);
  }
}

async function unwind(owned: Owned[], options: BootOptions): Promise<void> {
  while (owned.length) {
    const { plugin, dispose } = owned.pop()!;
    try {
      await dispose();
    } catch (err) {
      options.onDisposeError?.(plugin, err);
    }
  }
}

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value ?? null)).digest("hex");

/**
 * Boots a profile. All or nothing: every enabled plugin's config is parsed first, then plugins are applied in an
 * order where each one comes after every plugin that provides a seam it requires. If a config does not parse,
 * an `apply` throws, or a required seam has no provider, nothing is left running and the error names the plugin
 * and what was missing.
 */
export async function boot(profile: readonly PluginUse[], options: BootOptions = {}): Promise<Harness> {
  const env = options.env ?? process.env;
  const enabled = profile.filter((u) => u.enabled !== false);
  const names = new Set<string>();
  const parsed = enabled.map(({ plugin, config }) => {
    if (names.has(plugin.name)) throw new PluginContractError(`The plugin "${plugin.name}" is listed twice.`);
    names.add(plugin.name);
    const result = plugin.config.safeParse(config ?? {});
    if (!result.success) {
      const problems = result.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
      throw new PluginContractError(`The plugin "${plugin.name}" has config that is not valid (${problems}).`);
    }
    return { plugin, config: result.data as unknown };
  });

  const providers = new Map<SeamKey, string[]>();
  for (const { plugin } of parsed) for (const key of plugin.provides ?? []) providers.set(key, [...(providers.get(key) ?? []), plugin.name]);
  for (const { plugin } of parsed) {
    for (const key of plugin.inject?.required ?? []) {
      if (!providers.get(key)?.length) throw new PluginContractError(`The plugin "${plugin.name}" needs the "${key}" seam, and no enabled plugin provides it.`);
    }
  }

  // Order: a plugin waits for every other plugin that provides a seam it reads from.
  const waitsOn = (p: (typeof parsed)[number]) =>
    [...(p.plugin.inject?.required ?? []), ...(p.plugin.inject?.optional ?? [])].flatMap((key) => (providers.get(key) ?? []).filter((n) => n !== p.plugin.name));
  const order: typeof parsed = [];
  const placed = new Set<string>();
  while (order.length < parsed.length) {
    const ready = parsed.find((p) => !placed.has(p.plugin.name) && waitsOn(p).every((n) => placed.has(n)));
    if (!ready) {
      const stuck = parsed.filter((p) => !placed.has(p.plugin.name)).map((p) => p.plugin.name);
      throw new PluginContractError(`These plugins wait on each other, so none can start: ${stuck.join(", ")}.`);
    }
    order.push(ready);
    placed.add(ready.plugin.name);
  }

  const seams = new Registries();
  const effects: Owned[] = [];
  const reports: PluginReport[] = parsed.map(({ plugin, config }) => ({
    name: plugin.name,
    version: plugin.version ?? "0.0.0",
    state: "configured",
    provides: [...(plugin.provides ?? [])],
    requires: [...(plugin.inject?.required ?? [])],
    configSha256: sha(config),
  }));
  const harness = new Harness(seams, effects, reports, options);

  for (const { plugin, config } of order) {
    const report = reports.find((r) => r.name === plugin.name)!;
    const declared = new Set<SeamKey>([...(plugin.inject?.required ?? []), ...(plugin.inject?.optional ?? []), ...(plugin.provides ?? [])]);
    for (const key of plugin.inject?.required ?? []) {
      if (!seams.filled(key)) {
        report.state = "failed";
        report.error = `the "${key}" seam is empty`;
        await harness.dispose();
        throw new PluginContractError(`The plugin "${plugin.name}" needs the "${key}" seam, and nothing was registered into it.`);
      }
    }
    const ctx = {
      plugin: { name: plugin.name, version: report.version },
      scope: "process" as const,
      effect: (setup: () => Disposer | Promise<Disposer>) => {
        const slot = effects.length;
        effects.push({ plugin: plugin.name, dispose: () => undefined });
        return void Promise.resolve(setup()).then((dispose) => {
          effects[slot] = { plugin: plugin.name, dispose };
        });
      },
      onRun: (setup: (run: RunContext) => void | Promise<void>) => harness.addRunSetup(plugin.name, setup),
      secret: (name: string) => env[name] || undefined,
    } as Record<string, unknown>;
    for (const key of ["models", "sandbox", "search", "tools"] as const) {
      Object.defineProperty(ctx, key, {
        get: () => {
          if (!declared.has(key)) throw new PluginContractError(`The plugin "${plugin.name}" did not declare the "${key}" seam.`);
          return seams[key];
        },
      });
    }
    seams.current = plugin.name;
    try {
      await plugin.apply(ctx as PluginContext<SeamKey>, config as never);
      report.state = "active";
    } catch (err) {
      report.state = "failed";
      report.error = err instanceof Error ? err.message : String(err);
      await harness.dispose();
      throw new PluginContractError(`The plugin "${plugin.name}" failed to start: ${report.error}`);
    } finally {
      seams.current = "";
    }
  }
  return harness;
}
