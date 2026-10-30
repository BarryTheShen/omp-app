/**
 * The chat host's state methods (SDK plan H5.2b), end to end on the fake model provider: the full state, models,
 * thinking levels, the chat's name, statistics and export, todos, auto-compaction, compaction and handoff. Runs from
 * source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("the chat host's state methods", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the state reads back with omp's own fields, settled and empty`,
      async () => {
        const chat = await chats.start(command);
        const hello = await chat.client.hello;
        const state = await chat.client.request("get_state", {});
        expect(state).toMatchObject({
          model: { provider: "fake", id: "fake-model" },
          sessionId: hello.session.id,
          isStreaming: false,
          isSettled: true,
          queuedMessageCount: 0,
          queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
          todoPhases: [],
          goal: null,
        });
        expect(["all", "one-at-a-time"]).toContain(state.steeringMode);
        expect(state.systemPrompt.join("\n").length).toBeGreaterThan(0);
        expect(state.dumpTools.map((tool) => tool.name)).toContain("read");
      },
      60_000,
    );

    programTest(
      `${program.name}: the model changes to another available one, and an unknown model is refused`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const { models } = await chat.client.request("get_available_models", {});
        const other = models.find(
          (model) => model.provider === "fake" && model.id !== "fake-model",
        );
        expect(other).toBeDefined();
        const chosen = await chat.client.request("set_model", {
          provider: "fake",
          modelId: other?.id ?? "",
        });
        expect(chosen).toMatchObject({ provider: "fake", id: other?.id });
        expect((await chat.client.request("get_state", {})).model?.id).toBe(other?.id);
        await expect(
          chat.client.request("set_model", { provider: "fake", modelId: "no-such-model" }),
        ).rejects.toMatchObject({ code: "failed", message: "Model not found: fake/no-such-model" });
      },
      60_000,
    );

    programTest(
      `${program.name}: Ctrl+P's roles list in omp's order, skip a role without a model, and cycle both ways`,
      async () => {
        const chat = await chats.start(command, {
          config: [
            "modelRoles:",
            "  smol: fake/claude-3-haiku-20240307",
            "  slow: fake/claude-fable-5",
            "  plan: fake/no-such-model",
            "cycleOrder: [smol, default, plan, slow]",
            "",
          ].join("\n"),
        });
        await chat.client.hello;
        const listed = await chat.client.request("get_role_models", {});
        expect(listed.order).toEqual(["smol", "default", "plan", "slow"]);
        // `plan` names a model omp does not have: it is left out, as omp's Ctrl+P skips it.
        expect(listed.roles.map((role) => `${role.role}=${role.modelId}`)).toEqual([
          "smol=claude-3-haiku-20240307",
          "default=fake-model",
          "slow=claude-fable-5",
        ]);
        expect(listed.current).toBe("default");

        const forward = await chat.client.request("cycle_role_models", { direction: "forward" });
        expect(forward).toEqual({
          role: "slow",
          provider: "fake",
          modelId: "claude-fable-5",
          name: "Claude Fable 5",
          thinkingLevel: null,
        });
        expect((await chat.client.request("get_state", {})).model?.id).toBe("claude-fable-5");
        // After the last role comes the first, and back again.
        const wrapped = await chat.client.request("cycle_role_models", { direction: "forward" });
        expect(wrapped?.role).toBe("smol");
        const back = await chat.client.request("cycle_role_models", { direction: "backward" });
        expect(back?.role).toBe("slow");
        expect((await chat.client.request("get_role_models", {})).current).toBe("slow");

        // A model picked outside the roles is no role's.
        await chat.client.request("set_model", { provider: "fake", modelId: "fake-vision" });
        expect((await chat.client.request("get_role_models", {})).current).toBeNull();
      },
      60_000,
    );

    programTest(
      `${program.name}: with only the default role there is nothing to cycle`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const listed = await chat.client.request("get_role_models", {});
        expect(listed.roles.map((role) => role.role)).toEqual(["default"]);
        expect(await chat.client.request("cycle_role_models", { direction: "forward" })).toBeNull();
        expect((await chat.client.request("get_state", {})).model?.id).toBe("fake-model");
      },
      60_000,
    );

    programTest(
      `${program.name}: thinking levels list, set and cycle, and an unknown level is refused`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const { levels } = await chat.client.request("get_available_thinking_levels", {});
        expect(levels[0]).toBe("off");
        await chat.client.request("set_thinking_level", { level: "low" });
        expect(`${(await chat.client.request("get_state", {})).thinkingLevel}`).toBe("low");
        const cycled = await chat.client.request("cycle_thinking_level", {});
        expect(`${cycled?.level}`).not.toBe("low");
        await expect(
          chat.client.request("set_thinking_level", { level: "turbo" } as never),
        ).rejects.toMatchObject({ code: "invalid_params" });
      },
      60_000,
    );

    programTest(
      `${program.name}: the chat's name is trimmed, an empty one refused; statistics count the turn; the export is written`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "hello" });
        await chat.next(resultOf("1"));
        await chat.client.request("set_session_name", { name: "  Trip plan  " });
        expect((await chat.client.request("get_state", {})).sessionName).toBe("Trip plan");
        await expect(
          chat.client.request("set_session_name", { name: "   " }),
        ).rejects.toMatchObject({
          message: "Session name cannot be empty",
        });
        const stats = await chat.client.request("get_session_stats", {});
        expect(stats).toMatchObject({ userMessages: 1, assistantMessages: 1 });
        // omp names the page relative to the chat's folder when no path is given, as its RPC did.
        const { path } = await chat.client.request("export_html", {});
        expect(existsSync(resolve(chat.folder, path))).toBe(true);
      },
      60_000,
    );

    programTest(
      `${program.name}: todos set by the user read back`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const phases = [
          {
            name: "Plan",
            tasks: [
              { content: "Read the form", status: "completed" as const },
              { content: "Fix the check", status: "pending" as const },
            ],
          },
        ];
        const { todoPhases } = await chat.client.request("set_todos", { phases });
        expect(todoPhases).toMatchObject(phases);
        expect((await chat.client.request("get_state", {})).todoPhases).toMatchObject(phases);
      },
      60_000,
    );

    programTest(
      `${program.name}: auto-compaction turns off and on, and fast or slow mode the model lacks is refused`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("set_auto_compaction", { enabled: false });
        expect((await chat.client.request("get_state", {})).autoCompactionEnabled).toBe(false);
        await chat.client.request("set_auto_compaction", { enabled: true });
        expect((await chat.client.request("get_state", {})).autoCompactionEnabled).toBe(true);
        await expect(chat.client.request("set_fast_mode", { enabled: true })).rejects.toMatchObject(
          {
            message: "Fast mode is unavailable for the current model.",
          },
        );
        expect(await chat.client.request("set_fast_mode", { enabled: false })).toEqual({
          enabled: false,
          active: false,
        });
        const state = await chat.client.request("get_state", {});
        if (!state.slowModeSupported) {
          await expect(
            chat.client.request("set_slow_mode", { enabled: true }),
          ).rejects.toMatchObject({
            message: "Slow mode is unavailable for the current model.",
          });
        }
      },
      60_000,
    );

    programTest(
      `${program.name}: a reply is compacted into a summary, and a handoff is refused while a reply streams`,
      async () => {
        // omp keeps the most recent `keepRecentTokens` out of a summary (20000 by default); 1 leaves the first turn to it.
        const chat = await chats.start(command, { config: "compaction:\n  keepRecentTokens: 1\n" });
        await chat.client.hello;
        await chat.client.request("prompt", { text: "hello" });
        await chat.next(resultOf("1"));
        await chat.client.request("prompt", { text: "hello again" });
        await chat.next(resultOf("2"));
        const compacted = await chat.client.request("compact", {});
        expect(compacted.summary.length).toBeGreaterThan(0);

        // The earlier replies already sent updates: wait for the held reply's own, so the handoff meets it.
        const mark = chat.events.length;
        await chat.client.request("prompt", { text: "stream_held" });
        await chat.nextAfter(mark, (event) => event.type === "message_update");
        await expect(chat.client.request("handoff", {})).rejects.toMatchObject({
          message: "Cannot hand off while a response is in progress",
        });
        await chat.client.request("abort", {});
      },
      90_000,
    );
  }
});
