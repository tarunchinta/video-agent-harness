import type { z } from "zod";
import type { ModelProvider, SandboxFactory, SearchProvider, ToolDefinition } from "@harness/harness";

/**
 * The plugin contract, milestone 1 cut (docs/plans/PLUGIN_CONTRACT.md, section 11). A plugin is a name, the
 * seams it uses and provides, a config schema and one `apply`. The kernel (the event log, budgets, gates, the
 * tool pipeline and the loop) is not a plugin and cannot be replaced; everything a plugin adds goes in through
 * a seam.
 */

/** The seams this cut has. Each is a registry the kernel owns; plugins fill it and other plugins read from it. */
export type SeamKey = "models" | "sandbox" | "search" | "tools";

/** A model provider for every model name `handles` accepts. Built on first use, so a plugin with no key costs nothing until asked. */
export type ModelRoute = { name: string; handles(model: string): boolean; create(model: string): ModelProvider };

export interface ModelsSeam {
  register(route: ModelRoute): void;
  /** The provider for a model, from the first route that handles it. */
  get(model: string): ModelProvider;
  has(model: string): boolean;
}

/** What a run asks of its sandbox. Each run says how much network it gets, on its own record. */
export type SandboxSettings = { network: "none" | "public" };
/** Makes the sandbox factory for runs with these settings. */
export type SandboxDriver = (settings: SandboxSettings) => SandboxFactory;

/** One sandbox per run, so this seam has one provider. */
export interface SandboxSeam {
  provide(driver: SandboxDriver): void;
  get(): SandboxDriver | undefined;
}

export interface SearchSeam {
  register(name: string, provider: SearchProvider): void;
  /** A provider by name, or the first one registered. */
  get(name?: string): SearchProvider | undefined;
  names(): string[];
}

/** Tools for the agent. They run through the kernel's fixed pipeline; a plugin cannot loosen it. */
export interface ToolsSeam {
  register(tool: ToolDefinition): void;
  list(): ToolDefinition[];
}

export type Seams = { models: ModelsSeam; sandbox: SandboxSeam; search: SearchSeam; tools: ToolsSeam };

/** Undoes what a setup did. Called once, when the scope that ran the setup ends. */
export type Disposer = () => void | Promise<void>;

export type RunContext = {
  readonly runId: string;
  effect(setup: () => Disposer | Promise<Disposer>): void;
};

/** What `apply` is handed. Only the seams the plugin declared are on it; reaching for another throws. */
export type PluginContext<K extends SeamKey> = {
  readonly plugin: { name: string; version: string };
  readonly scope: "process";
  /** A reversible side effect. Its disposer runs when the harness is disposed, newest first. */
  effect(setup: () => Disposer | Promise<Disposer>): void;
  /** Work to do for each run, undone when the run's scope ends. */
  onRun(setup: (run: RunContext) => void | Promise<void>): void;
  /**
   * A secret, read when it is needed and never stored in config, so a plugin's config hash and the event log
   * never hold one. Undefined when it is not set.
   */
  secret(name: string): string | undefined;
} & Pick<Seams, K>;

export type PluginDefinition<C extends z.ZodType = z.ZodType, U extends SeamKey = SeamKey, P extends SeamKey = SeamKey> = {
  /** kebab-case, `<seam>-<vendor>` for providers. */
  name: string;
  version?: string;
  inject?: {
    /** Seams this plugin reads from. It is applied only after every plugin that provides them. */
    required?: readonly U[];
    /** Seams it reads from if anything provides them. */
    optional?: readonly U[];
  };
  /** Seams this plugin registers into. */
  provides?: readonly P[];
  config: C;
  apply(ctx: PluginContext<U | P>, config: z.output<C>): void | Promise<void>;
};

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export class PluginContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginContractError";
  }
}

export function definePlugin<C extends z.ZodType, U extends SeamKey = never, P extends SeamKey = never>(
  plugin: PluginDefinition<C, U, P>,
): PluginDefinition<C, U, P> {
  if (!NAME_RE.test(plugin.name)) throw new PluginContractError(`Plugin name "${plugin.name}" must be kebab-case.`);
  return plugin;
}

/** One entry of a profile: a plugin and the config to parse for it. */
export type PluginUse = { plugin: PluginDefinition<z.ZodType, SeamKey, SeamKey>; config?: unknown; enabled?: boolean };

export function use<C extends z.ZodType, U extends SeamKey, P extends SeamKey>(
  plugin: PluginDefinition<C, U, P>,
  config?: z.input<C>,
  options: { enabled?: boolean } = {},
): PluginUse {
  return { plugin: plugin as unknown as PluginUse["plugin"], config, ...(options.enabled === undefined ? {} : { enabled: options.enabled }) };
}
