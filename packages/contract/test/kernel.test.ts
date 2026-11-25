import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type SearchProvider } from "@harness/harness";
import { ScriptedProvider } from "@harness/harness/testing";
import { boot, definePlugin, PluginContractError, use } from "../src/index.ts";

const fakeSearch = (id: string): SearchProvider => ({ id, search: async () => [] });

const models = definePlugin({
  name: "model-scripted",
  provides: ["models"],
  config: z.object({ prefix: z.string().default("test-") }),
  apply(ctx, config) {
    ctx.models.register({ name: "scripted", handles: (m) => m.startsWith(config.prefix), create: () => new ScriptedProvider([]) });
  },
});

const search = definePlugin({
  name: "search-fake",
  provides: ["search"],
  config: z.object({}),
  apply(ctx) {
    if (ctx.secret("FAKE_SEARCH_KEY")) ctx.search.register("fake", fakeSearch("fake"));
  },
});

/** A tool pack that needs search: it must start after whatever provides it. */
const research = definePlugin({
  name: "tools-research",
  inject: { required: ["search"] },
  provides: ["tools"],
  config: z.object({}),
  apply(ctx) {
    const provider = ctx.search.get()!;
    ctx.tools.register(defineTool({ name: "find", description: `Search with ${provider.id}.`, input: z.object({}), execute: async () => "found" }) as never);
  },
});

describe("booting plugins", () => {
  it("applies plugins after the ones they depend on, whatever order they are listed in", async () => {
    const harness = await boot([use(research), use(models), use(search)], { env: { FAKE_SEARCH_KEY: "k" } });
    expect(harness.plugins.map((p) => [p.name, p.state])).toEqual([
      ["tools-research", "active"],
      ["model-scripted", "active"],
      ["search-fake", "active"],
    ]);
    expect(harness.tools.map((t) => [t.name, t.plugin])).toEqual([["find", "tools-research"]]);
    expect(harness.model("test-model").id).toBe("scripted");
    expect(harness.hasModel("other-model")).toBe(false);
    expect(() => harness.model("other-model")).toThrow('No plugin provides the model "other-model"');
  });

  it("is all or nothing: a bad config, a missing seam or a failing apply leaves nothing running", async () => {
    await expect(boot([use(models, { prefix: 3 as unknown as string })])).rejects.toThrow('The plugin "model-scripted" has config that is not valid (prefix:');
    await expect(boot([use(research)])).rejects.toThrow('The plugin "tools-research" needs the "search" seam, and no enabled plugin provides it.');
    // The search plugin is there but registered nothing, because its key is missing.
    await expect(boot([use(search), use(research)], { env: {} })).rejects.toThrow('needs the "search" seam, and nothing was registered into it.');

    const undone: string[] = [];
    const tidy = definePlugin({ name: "tidy", provides: ["tools"], config: z.object({}), apply(ctx) {
        ctx.effect(() => () => void undone.push("tidy"));
        ctx.tools.register(defineTool({ name: "noop", description: "Does nothing.", input: z.object({}), execute: async () => "ok" }) as never);
      },
    });
    const broken = definePlugin({ name: "broken", inject: { required: ["tools"] }, config: z.object({}), apply() { throw new Error("no luck"); } });
    await expect(boot([use(tidy), use(broken)])).rejects.toThrow('The plugin "broken" failed to start: no luck');
    expect(undone).toEqual(["tidy"]);
  });

  it("keeps a plugin to the seams it declared", async () => {
    const sneaky = definePlugin({ name: "sneaky", config: z.object({}), apply(ctx) { (ctx as unknown as { tools: { list(): unknown } }).tools.list(); } });
    await expect(boot([use(sneaky)])).rejects.toThrow('The plugin "sneaky" did not declare the "tools" seam.');
  });

  it("allows one sandbox provider and unwinds effects newest first, carrying on past one that throws", async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const box = (name: string) =>
      definePlugin({
        name,
        provides: ["sandbox"],
        config: z.object({}),
        apply(ctx) {
          ctx.effect(() => () => void order.push(`${name} first`));
          ctx.effect(() => () => {
            throw new Error(`${name} could not tidy up`);
          });
          ctx.effect(() => () => void order.push(`${name} last`));
          ctx.sandbox.provide(() => async () => { throw new Error("not in a test"); });
        },
      });
    await expect(boot([use(box("sandbox-a")), use(box("sandbox-b"))])).rejects.toThrow('already provides it');
    order.length = 0;
    const harness = await boot([use(box("sandbox-a"))], { onDisposeError: (_plugin, err) => errors.push((err as Error).message) });
    expect(harness.sandbox).toBeTypeOf("function");
    await harness.dispose();
    await harness.dispose();
    expect(order).toEqual(["sandbox-a last", "sandbox-a first"]);
    expect(errors).toEqual(["sandbox-a could not tidy up"]);
  });

  it("records each plugin's config by hash, never its secrets, and skips plugins that are turned off", async () => {
    const a = await boot([use(models, { prefix: "test-" }), use(search, {}, { enabled: false })], { env: { FAKE_SEARCH_KEY: "very-secret" } });
    const b = await boot([use(models, { prefix: "test-" })]);
    expect(a.plugins.map((p) => p.name)).toEqual(["model-scripted"]);
    expect(a.plugins[0]!.configSha256).toBe(b.plugins[0]!.configSha256);
    expect(JSON.stringify(a.plugins)).not.toContain("very-secret");
  });

  it("runs per-run setup and undoes it when the run's scope closes", async () => {
    const log: string[] = [];
    const perRun = definePlugin({
      name: "per-run",
      config: z.object({}),
      apply(ctx) {
        ctx.onRun((run) => {
          log.push(`open ${run.runId}`);
          run.effect(() => () => void log.push(`close ${run.runId}`));
        });
      },
    });
    const harness = await boot([use(perRun)]);
    const close = await harness.openRun("run-1");
    await close();
    expect(log).toEqual(["open run-1", "close run-1"]);
  });

  it("refuses names that are not kebab-case and plugins listed twice", async () => {
    expect(() => definePlugin({ name: "Bad_Name", config: z.object({}), apply() {} })).toThrow(PluginContractError);
    await expect(boot([use(models), use(models)])).rejects.toThrow('The plugin "model-scripted" is listed twice.');
  });
});
