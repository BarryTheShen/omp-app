/**
 * Plan mode on the chat host (SDK plan H5.2g3, the host half of #768), end to end on the fake model provider: its
 * `plan_propose` writes a plan and submits it as omp's plan prompt asks, and `plan_write_outside` writes outside the
 * plan. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Chat, chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** The plan `plan_propose` writes (`PLAN_TEXT` in the fake provider), and the file its slug names. */
const PLAN_TEXT = "# Fix the login\n\n1. Read the login form.\n2. Fix the password check.\n";
const PLAN_FILE = "local://fix-the-login-plan.md";

interface WireMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly toolCallId?: string;
  readonly details?: unknown;
  readonly synthetic?: boolean;
  readonly isError?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("");
}

async function messages(chat: Chat): Promise<WireMessage[]> {
  const { entries } = await chat.client.request("get_entries", {});
  return entries.flatMap((entry) =>
    entry.type === "message" ? [entry.message as WireMessage] : [],
  );
}

function toolResult(all: readonly WireMessage[], callId: string): WireMessage | undefined {
  return all.find((message) => message.role === "toolResult" && message.toolCallId === callId);
}

async function modes(chat: Chat): Promise<string[]> {
  const { entries } = await chat.client.request("get_entries", {});
  return entries.flatMap((entry) => (entry.type === "mode_change" ? [entry.mode] : []));
}

/** Sends a prompt and waits for its result. */
async function promptToEnd(chat: Chat, text: string): Promise<void> {
  const mark = chat.events.length;
  await chat.client.request("prompt", { text });
  await chat.nextAfter(mark, (event) => event.type === "prompt_result");
}

describe("plan mode on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: plans read-only, proposes, and the approved plan runs and names the chat`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        expect(await chat.client.request("get_plan_mode", {})).toEqual({
          enabled: false,
          available: true,
        });
        expect(await chat.client.request("set_plan_mode", { enabled: true })).toEqual({
          enabled: true,
          available: true,
          planFilePath: "local://PLAN.md",
        });

        // omp's guard keeps the working tree read-only while planning.
        await promptToEnd(chat, "plan_write_outside");
        expect(await Bun.file(join(chat.folder, "outside-the-plan.txt")).exists()).toBe(false);
        expect(toolResult(await messages(chat), "call_plan_outside")?.isError).toBe(true);

        // The model writes its plan and submits it; omp's review answers with the plan's file, and plan mode stays on.
        await promptToEnd(chat, "plan_propose");
        const proposal = toolResult(await messages(chat), "call_plan_propose");
        expect(proposal).toMatchObject({
          details: { xdev: { tool: "propose", inner: { planFilePath: PLAN_FILE } } },
        });
        expect(textOf(proposal?.content)).toContain("Plan ready for review.");
        expect(await chat.client.request("get_plan", { planFilePath: PLAN_FILE })).toEqual({
          planFilePath: PLAN_FILE,
          content: PLAN_TEXT,
        });
        expect(await chat.client.request("get_plan_mode", {})).toMatchObject({ enabled: true });

        const mark = chat.events.length;
        expect(
          await chat.client.request("approve_plan", {
            planFilePath: PLAN_FILE,
            title: "fix-the-login",
          }),
        ).toEqual({ planFilePath: PLAN_FILE });
        expect(await chat.client.request("get_plan_mode", {})).toEqual({
          enabled: false,
          available: true,
        });
        await chat.nextAfter(mark, (event) => event.type === "session_settled");

        // The run on the plan: omp's hidden developer message with the plan inline, and the model's answer after it.
        const all = await messages(chat);
        const start = all.findIndex(
          (message) =>
            message.role === "developer" &&
            message.synthetic === true &&
            textOf(message.content).includes("# Fix the login"),
        );
        expect(start).toBeGreaterThanOrEqual(0);
        expect(all.slice(start + 1).some((message) => message.role === "assistant")).toBe(true);
        expect((await chat.client.request("get_state", {})).sessionName).toBe("Fix the login");
        expect(await modes(chat)).toEqual(["plan", "none"]);
      },
      120_000,
    );

    programTest(
      `${program.name}: what omp refuses is refused, with the app's codes`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await expect(
          chat.client.request("approve_plan", { planFilePath: PLAN_FILE }),
        ).rejects.toMatchObject({ code: "plan_mode_off" });
        await expect(chat.client.request("get_plan", {})).rejects.toMatchObject({
          code: "plan_missing",
        });

        await chat.client.request("prompt", { text: "stream_held" });
        await chat.next((event) => event.type === "message_update");
        await expect(chat.client.request("set_plan_mode", { enabled: true })).rejects.toMatchObject(
          {
            code: "session_busy",
          },
        );
        await chat.client.request("abort", {});
        await chat.next((event) => event.type === "prompt_result");

        await chat.client.request("goal", { op: "create", objective: "Ship the release" });
        await expect(chat.client.request("set_plan_mode", { enabled: true })).rejects.toMatchObject(
          {
            code: "goal_active",
          },
        );
        await chat.client.request("goal", { op: "pause" });
        await expect(chat.client.request("set_plan_mode", { enabled: true })).rejects.toMatchObject(
          {
            code: "goal_active",
          },
        );
        expect(await chat.client.request("get_plan_mode", {})).toMatchObject({ enabled: false });

        const off = await chats.start(command, { config: "plan:\n  enabled: false\n" });
        await off.client.hello;
        expect(await off.client.request("get_plan_mode", {})).toEqual({
          enabled: false,
          available: false,
        });
        await expect(off.client.request("set_plan_mode", { enabled: true })).rejects.toMatchObject({
          code: "plan_disabled",
        });
      },
      120_000,
    );

    programTest(
      `${program.name}: a branch comes back in plan mode from its journal, a new chat leaves it, and Start in Plan Mode opens fresh chats in it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("set_plan_mode", { enabled: true });
        await promptToEnd(chat, "hello");
        await chat.client.request("set_plan_mode", { enabled: false });
        const { entries } = await chat.client.request("get_entries", {});
        const prompt = entries.find(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
        // Plan mode is off now, but the branch's session ends with the plan entry before that prompt, so it is on again.
        await chat.client.request("branch", { entryId: prompt?.id ?? "" });
        expect(await chat.client.request("get_plan_mode", {})).toMatchObject({ enabled: true });
        expect(await chat.client.request("new_session", {})).toEqual({ cancelled: false });
        expect(await chat.client.request("get_plan_mode", {})).toEqual({
          enabled: false,
          available: true,
        });
        // Plan mode ended with the session it belonged to: nothing about it is written into the new one.
        expect(await modes(chat)).toEqual([]);

        const planning = await chats.start(command, {
          config: "plan:\n  defaultOnStartup: true\n",
        });
        await planning.client.hello;
        expect(await planning.client.request("get_plan_mode", {})).toMatchObject({ enabled: true });
        await planning.client.request("set_plan_mode", { enabled: false });
        await planning.client.request("new_session", {});
        expect(await planning.client.request("get_plan_mode", {})).toMatchObject({ enabled: true });
      },
      120_000,
    );
  }
});
