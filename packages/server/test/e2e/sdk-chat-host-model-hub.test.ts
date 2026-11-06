/**
 * The chat host's model hub methods (`get_model_hub`, `assign_model_role`, `clear_model_role`), end to end on real omp
 * with the fake model provider: the roles and models omp's hub (Alt+M) shows, and its assign and clear writes, with the
 * settings files omp saves. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { type Chat, chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** The settings files of a chat: omp's global `config.yml` in the agent folder, and the project's in its `.omp` folder. */
function settingsFiles(chat: Chat) {
  return {
    global: join(dirname(chat.folder), "agent", "config.yml"),
    project: join(chat.folder, ".omp", "config.yml"),
  };
}

/** Waits for omp to save a role into a settings file (it saves a moment after the change); null is an absent role. */
async function savedRole(file: string, role: string, expected: string | null): Promise<void> {
  const deadline = Date.now() + 20_000;
  let seen: string | null = null;
  while (Date.now() < deadline) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    const settings: { modelRoles?: Record<string, string | null> } | null = parse(text);
    seen = settings?.modelRoles?.[role] ?? null;
    if (seen === expected) return;
    await Bun.sleep(100);
  }
  throw new Error(`${file} holds ${role}: ${seen}, not ${expected}`);
}

/** Waits for omp to save a role's fallback chain into a settings file; null is an absent chain. */
async function savedChain(
  file: string,
  role: string,
  expected: readonly string[] | null,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let seen: readonly string[] | null = null;
  while (Date.now() < deadline) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    const settings: { retry?: { fallbackChains?: Record<string, string[]> } } | null = parse(text);
    seen = settings?.retry?.fallbackChains?.[role] ?? null;
    if (JSON.stringify(seen) === JSON.stringify(expected)) return;
    await Bun.sleep(100);
  }
  throw new Error(
    `${file} holds ${role}'s fallbacks: ${JSON.stringify(seen)}, not ${JSON.stringify(expected)}`,
  );
}

/** Waits for omp to save a model's compaction entry into a settings file; null is an absent entry. */
async function savedThreshold(
  file: string,
  key: string,
  expected: number | string | null,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let seen: number | string | null = null;
  while (Date.now() < deadline) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    const settings: {
      compaction?: { modelThresholds?: Record<string, number | string> };
    } | null = parse(text);
    seen = settings?.compaction?.modelThresholds?.[key] ?? null;
    if (seen === expected) return;
    await Bun.sleep(100);
  }
  throw new Error(`${file} holds ${key}'s compaction limit: ${seen}, not ${expected}`);
}

describe("the chat host's model hub methods", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the hub lists the roles with their models and the models with their levels and roles`,
      async () => {
        const chat = await chats.start(command, {
          config: ["modelRoles:", "  smol: fake/claude-3-haiku-20240307", ""].join("\n"),
        });
        await chat.client.hello;
        const hub = await chat.client.request("get_model_hub", {});
        expect(hub.storage).toBe("global");
        expect(hub.current).toEqual({ provider: "fake", modelId: "fake-model" });

        const row = (role: string) => hub.roles.find((each) => each.role === role);
        // A configured role resolves to its model; it is not omp's auto-selection.
        expect(row("smol")).toMatchObject({
          tag: "SMOL",
          name: "Fast",
          section: "chat",
          value: "fake/claude-3-haiku-20240307",
          provenance: "global",
          model: { provider: "fake", modelId: "claude-3-haiku-20240307", name: "Claude Haiku 3" },
          autoSelected: false,
        });
        // A role without a setting shows omp's auto-selection.
        expect(row("slow")).toMatchObject({
          value: null,
          provenance: "default",
          autoSelected: true,
        });
        expect(row("slow")?.model).not.toBeNull();
        expect(row("default")?.model).toMatchObject({ provider: "fake", modelId: "fake-model" });
        // The kinds of runner are in the hub too, and the fake provider has no model for them.
        expect(row("image")).toMatchObject({ section: "kind", model: null, autoSelected: false });

        const model = (modelId: string) =>
          hub.models.find((each) => each.provider === "fake" && each.modelId === modelId);
        // A model that does not reason has no thinking levels; one that does offers inherit and off first.
        expect(model("claude-3-haiku-20240307")).toMatchObject({
          provider: "fake",
          name: "Claude Haiku 3",
          contextWindow: 200000,
          reasoning: false,
          thinkingLevels: [],
        });
        expect(model("claude-fable-5")?.reasoning).toBe(true);
        expect(model("claude-fable-5")?.thinkingLevels.slice(0, 2)).toEqual(["inherit", "off"]);
        // A chat model is accepted by the chat roles and not by the kinds of runner.
        const accepting = model("claude-fable-5")?.roles ?? [];
        expect(accepting).toEqual(expect.arrayContaining(["default", "smol", "slow"]));
        expect(accepting).not.toContain("image");
        expect(accepting).not.toContain("speech");
      },
      60_000,
    );

    programTest(
      `${program.name}: a --models scope is the hub's pool, as in omp`,
      async () => {
        const chat = await chats.start(command, {
          args: ["--models", "fake/fake-model,fake/claude-fable-5"],
        });
        await chat.client.hello;
        const hub = await chat.client.request("get_model_hub", {});
        // The scope is the pool for the chat models; the runners of other kinds (search, image, …) stay.
        const fakeModels = hub.models.filter((model) => model.provider === "fake");
        expect(fakeModels.map((model) => model.modelId).sort()).toEqual([
          "claude-fable-5",
          "fake-model",
        ]);
      },
      60_000,
    );

    programTest(
      `${program.name}: assigning default switches the chat and saves omp's global settings`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const result = await chat.client.request("assign_model_role", {
          provider: "fake",
          modelId: "claude-fable-5",
          role: "default",
        });
        expect(result).toEqual({ applied: true, status: "Default model: fake/claude-fable-5" });
        expect((await chat.client.request("get_state", {})).model?.id).toBe("claude-fable-5");
        await savedRole(settingsFiles(chat).global, "default", "fake/claude-fable-5");

        const hub = await chat.client.request("get_model_hub", {});
        expect(hub.current).toEqual({ provider: "fake", modelId: "claude-fable-5" });
        // The hub lists the default role's model first.
        expect(hub.models[0]).toMatchObject({ provider: "fake", modelId: "claude-fable-5" });
        expect(hub.roles.find((each) => each.role === "default")).toMatchObject({
          value: "fake/claude-fable-5",
          model: { modelId: "claude-fable-5" },
          autoSelected: false,
        });
      },
      60_000,
    );

    programTest(
      `${program.name}: assigning another role writes its setting and leaves the live model alone`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const result = await chat.client.request("assign_model_role", {
          provider: "fake",
          modelId: "claude-fable-5",
          role: "smol",
          thinkingLevel: "high",
        });
        expect(result).toEqual({ applied: true, status: "SMOL model: fake/claude-fable-5" });
        expect((await chat.client.request("get_state", {})).model?.id).toBe("fake-model");
        await savedRole(settingsFiles(chat).global, "smol", "fake/claude-fable-5:high");

        const hub = await chat.client.request("get_model_hub", {});
        expect(hub.roles.find((each) => each.role === "smol")).toMatchObject({
          value: "fake/claude-fable-5:high",
          model: { modelId: "claude-fable-5" },
          thinkingLevel: "high",
          autoSelected: false,
        });
      },
      60_000,
    );

    programTest(
      `${program.name}: clearing a role returns it to omp's auto-selection`,
      async () => {
        const chat = await chats.start(command, {
          config: [
            "modelRoles:",
            "  smol: fake/claude-3-haiku-20240307",
            "  default: fake/claude-3-5-sonnet-20240620",
            "",
          ].join("\n"),
        });
        await chat.client.hello;
        const cleared = await chat.client.request("clear_model_role", { role: "smol" });
        expect(cleared).toEqual({
          status: "SMOL role cleared — auto-selection applies",
          switchedTo: null,
        });
        await savedRole(settingsFiles(chat).global, "smol", null);
        const hub = await chat.client.request("get_model_hub", {});
        const smol = hub.roles.find((each) => each.role === "smol");
        expect(smol).toMatchObject({ value: null, autoSelected: true });
        expect(smol?.model).not.toBeNull();

        // With no other layer to fall back to, clearing default leaves the live chat as it is.
        const clearedDefault = await chat.client.request("clear_model_role", { role: "default" });
        expect(clearedDefault).toEqual({
          status: "DEFAULT role cleared — auto-selection applies",
          switchedTo: null,
        });
        await savedRole(settingsFiles(chat).global, "default", null);
        expect((await chat.client.request("get_state", {})).model?.id).toBe("fake-model");
      },
      60_000,
    );

    programTest(
      `${program.name}: a role's fallback chain is listed, written to retry.fallbackChains and cleared (#2838)`,
      async () => {
        // No chain in the starting settings: the harness writes its own `retry` block, and a second one would repeat the key.
        const chat = await chats.start(command);
        await chat.client.hello;
        const file = settingsFiles(chat).global;
        const fallbacksOf = async (role: string) =>
          (await chat.client.request("get_model_hub", {})).roles.find((each) => each.role === role)
            ?.fallbacks;
        expect(await fallbacksOf("default")).toEqual([]);

        const smol = ["fake/claude-3-haiku-20240307"];
        expect(
          await chat.client.request("set_role_fallbacks", { role: "smol", chain: smol }),
        ).toEqual({
          status: `SMOL fallbacks: ${smol[0]}`,
        });
        const chain = ["fake/claude-3-haiku-20240307", "fake/claude-3-5-sonnet-20240620:low"];
        const set = await chat.client.request("set_role_fallbacks", { role: "default", chain });
        expect(set).toEqual({ status: `DEFAULT fallbacks: ${chain.join(" → ")}` });
        expect(await fallbacksOf("default")).toEqual(chain);
        expect(await fallbacksOf("smol")).toEqual(smol);
        await savedChain(file, "default", chain);

        const cleared = await chat.client.request("set_role_fallbacks", {
          role: "default",
          chain: [],
        });
        expect(cleared).toEqual({ status: "DEFAULT fallbacks cleared" });
        expect(await fallbacksOf("default")).toEqual([]);
        await savedChain(file, "default", null);
        // The other role's chain is left as it was.
        expect(await fallbacksOf("smol")).toEqual(smol);
        await savedChain(file, "smol", smol);
      },
      60_000,
    );

    programTest(
      `${program.name}: a preset saves the roles, is the active one while they match, switches back, and is deleted (#2838)`,
      async () => {
        const chat = await chats.start(command, {
          config: ["modelRoles:", "  smol: fake/claude-3-haiku-20240307", ""].join("\n"),
        });
        await chat.client.hello;
        const presets = async () => (await chat.client.request("get_model_hub", {})).presets;
        const smolValue = async () =>
          (await chat.client.request("get_model_hub", {})).roles.find(
            (each) => each.role === "smol",
          )?.value;
        expect(await presets()).toEqual({ names: [], active: null });

        expect(await chat.client.request("save_model_preset", { name: "work" })).toEqual({
          status: 'Saved model preset "work"',
        });
        expect(await presets()).toEqual({ names: ["work"], active: "work" });

        // The roles change: no preset matches them any more.
        await chat.client.request("assign_model_role", {
          provider: "fake",
          modelId: "claude-fable-5",
          role: "smol",
        });
        expect(await smolValue()).toBe("fake/claude-fable-5");
        expect((await presets()).active).toBeNull();

        // Switching back writes the preset's roles.
        const applied = await chat.client.request("apply_model_preset", { name: "work" });
        expect(applied.clean).toBe(true);
        expect(applied.status).toMatch(/^Switched to preset "work" \(fake\//);
        expect(await smolValue()).toBe("fake/claude-3-haiku-20240307");
        expect((await presets()).active).toBe("work");

        await expect(chat.client.request("save_model_preset", { name: "1st" })).rejects.toThrow(
          'Invalid preset name "1st": use a letter, then letters, digits, - or _',
        );
        expect(await chat.client.request("delete_model_preset", { name: "work" })).toEqual({
          status: 'Deleted model preset "work"',
          deleted: true,
        });
        expect(await presets()).toEqual({ names: [], active: null });
        expect(await chat.client.request("delete_model_preset", { name: "work" })).toEqual({
          status: "Preset not found: work",
          deleted: false,
        });
      },
      60_000,
    );

    programTest(
      `${program.name}: a model's compaction limit is previewed, written to compaction.modelThresholds and removed (#2838)`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const file = settingsFiles(chat).global;
        const haiku = { provider: "fake", modelId: "claude-3-haiku-20240307" };
        const key = `${haiku.provider}/${haiku.modelId}`;
        const point = async () =>
          (await chat.client.request("get_model_hub", {})).models.find(
            (each) => `${each.provider}/${each.modelId}` === key,
          )?.compaction;
        // No entry of its own: omp's own policy decides.
        const before = await point();
        expect(before).toMatchObject({ source: "default", draft: null });

        // omp's line for typed text, before anything is written; none for text omp does not read.
        const preview = await chat.client.request("preview_compaction_point", {
          ...haiku,
          input: "f150k",
        });
        expect(preview.preview).toContain("150K");
        expect(
          await chat.client.request("preview_compaction_point", { ...haiku, input: "lots" }),
        ).toEqual({ preview: null });
        expect(await point()).toEqual(before);

        const saved = await chat.client.request("set_compaction_point", {
          ...haiku,
          input: "f150k",
        });
        expect(saved).toEqual({
          kind: "saved",
          status: `Compaction limit for ${key}: fixed at 150,000 tokens · ${preview.preview}`,
        });
        expect(await point()).toMatchObject({ tokens: 150_000, source: key, draft: "f150k" });
        await savedThreshold(file, key, "f150000");

        await expect(
          chat.client.request("set_compaction_point", { ...haiku, input: "lots" }),
        ).rejects.toThrow('Invalid compaction point "lots"');
        // A fixed trigger must stay under the model's window (200K): refused, and the entry stays.
        await expect(
          chat.client.request("set_compaction_point", { ...haiku, input: "f300k" }),
        ).rejects.toThrow();
        expect((await point())?.draft).toBe("f150k");

        const removed = await chat.client.request("set_compaction_point", { ...haiku, input: "" });
        expect(removed).toMatchObject({ kind: "saved" });
        expect(removed.kind === "saved" && removed.status).toMatch(
          new RegExp(`^Compaction limit for ${key}: reset`),
        );
        expect(await point()).toEqual(before);
        await savedThreshold(file, key, null);
      },
      60_000,
    );

    programTest(
      `${program.name}: with project storage default is assigned to the project, and clearing it returns to the global one`,
      async () => {
        const chat = await chats.start(command, {
          config: [
            "modelRoleStorage: project",
            "modelRoles:",
            "  default: fake/claude-3-5-sonnet-20240620",
            "",
          ].join("\n"),
        });
        await chat.client.hello;
        const files = settingsFiles(chat);
        expect((await chat.client.request("get_model_hub", {})).storage).toBe("project");

        const assigned = await chat.client.request("assign_model_role", {
          provider: "fake",
          modelId: "claude-fable-5",
          role: "default",
          scope: "project",
        });
        expect(assigned).toEqual({
          applied: true,
          status: "Project default model: fake/claude-fable-5",
        });
        expect((await chat.client.request("get_state", {})).model?.id).toBe("claude-fable-5");
        await savedRole(files.project, "default", "fake/claude-fable-5");
        // The global setting is untouched.
        await savedRole(files.global, "default", "fake/claude-3-5-sonnet-20240620");

        const cleared = await chat.client.request("clear_model_role", {
          role: "default",
          scope: "project",
        });
        expect(cleared).toEqual({
          status: "Project DEFAULT role cleared — auto-selection applies",
          switchedTo: "fake/claude-3-5-sonnet-20240620",
        });
        expect((await chat.client.request("get_state", {})).model?.id).toBe(
          "claude-3-5-sonnet-20240620",
        );
        await savedRole(files.project, "default", null);
        await savedRole(files.global, "default", "fake/claude-3-5-sonnet-20240620");
      },
      60_000,
    );

    programTest(
      `${program.name}: assigning default with the auto thinking level puts the chat on auto`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const mark = chat.events.length;
        const result = await chat.client.request("assign_model_role", {
          provider: "fake",
          modelId: "claude-fable-5",
          role: "default",
          thinkingLevel: "auto",
        });
        expect(result).toEqual({ applied: true, status: "Default model: fake/claude-fable-5" });
        const state = await chat.client.request("get_state", {});
        expect(state.model?.id).toBe("claude-fable-5");
        // omp reports auto mode in its thinking-level event; the state's level is the one auto picked for now.
        await chat.nextAfter(
          mark,
          (event) => event.type === "thinking_level_changed" && event.configured === "auto",
        );
      },
      60_000,
    );

    programTest(
      `${program.name}: an unknown model and an unknown thinking level are refused`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await expect(
          chat.client.request("assign_model_role", {
            provider: "fake",
            modelId: "no-such-model",
            role: "smol",
          }),
        ).rejects.toMatchObject({ code: "failed", message: "Model not found: fake/no-such-model" });
        await expect(
          chat.client.request("assign_model_role", {
            provider: "fake",
            modelId: "fake-model",
            role: "smol",
            thinkingLevel: "turbo",
          } as never),
        ).rejects.toMatchObject({ code: "invalid_params" });
        await expect(chat.client.request("clear_model_role", { role: "" })).rejects.toMatchObject({
          code: "invalid_params",
        });
      },
      60_000,
    );
  }
});
