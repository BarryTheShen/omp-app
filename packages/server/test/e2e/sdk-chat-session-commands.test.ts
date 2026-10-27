/**
 * The A1 command gateway on the chat host (SDK plan H5.3e), end to end: slash commands through the chat session port's
 * runtime on real chat hosts. Runs from source and compiled (`sdk-chat-session-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompactionEvent, ThreadId } from "@omp-app/contracts";
import {
  createOmpCommandGateway,
  type OmpCommandGatewayService,
} from "../../src/modules/A1/gateway";
import { PROGRAMS, realTest } from "./sdk-chat-host-harness";
import {
  call,
  chatSessionPorts,
  type PortSetup,
  streamOf,
  until,
} from "./sdk-chat-session-harness";

const ports = chatSessionPorts();
afterEach(() => ports.stopAll(), 60_000);

/** A user skill: its body is a rule for the fake model, so the model answers it. */
const GREET_SKILL = `---
name: greet
description: Says hello for the e2e test.
---
context_has skillword7
`;

/** The app's gateway, reading the chats of this port's runtime. */
function gatewayFor(setup: PortSetup): OmpCommandGatewayService {
  return createOmpCommandGateway({
    resolveSession: (threadId) => {
      const session = setup.runtime.commandSessionFor(threadId);
      if (session === undefined) throw new Error(`no command session for ${threadId}`);
      return session;
    },
  });
}

async function newChat(setup: PortSetup): Promise<ThreadId> {
  return (await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call())).threadId;
}

describe("the A1 command gateway on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a built-in command is answered in place, with its output`,
      async () => {
        const setup = await ports.start(command);
        const threadId = await newChat(setup);
        const run = gatewayFor(setup).run({ threadId, command: "/session info" });
        expect(await run.admitted).toEqual({ agentInvoked: false });
        const result = await run;
        expect(result).toMatchObject({
          status: "completed",
          agentInvoked: false,
          promptSettled: true,
        });
        expect(result.outputs.map((output) => output.text).join("\n")).toContain(
          `Session: ${threadId}`,
        );
      },
      90_000,
    );

    programTest(
      `${program.name}: a skill command reaches the model and settles with its own prompt's result`,
      async () => {
        const setup = await ports.start(command, {
          agentFiles: { "skills/greet/SKILL.md": GREET_SKILL },
          nativeDiscovery: true,
        });
        const threadId = await newChat(setup);
        const run = gatewayFor(setup).run({ threadId, command: "/skill:greet" });
        expect(await run.admitted).toEqual({ agentInvoked: true });
        expect(await run).toMatchObject({
          status: "completed",
          agentInvoked: true,
          promptSettled: true,
        });
        expect(
          streamOf(setup, threadId).some(
            (payload) => payload.kind === "event" && payload.event.type === "prompt_result",
          ),
        ).toBe(true);
      },
      90_000,
    );

    programTest(
      `${program.name}: a command missing from the chat's list is refused, and nothing is sent`,
      async () => {
        const setup = await ports.start(command);
        const threadId = await newChat(setup);
        const mark = streamOf(setup, threadId).length;
        await expect(
          gatewayFor(setup).run({ threadId, command: "/no-such-command" }),
        ).rejects.toMatchObject({ appError: { code: "unavailable" } });
        expect(
          streamOf(setup, threadId)
            .slice(mark)
            .some((payload) => payload.kind === "event" && payload.event.type === "agent_start"),
        ).toBe(false);
      },
      90_000,
    );

    programTest(
      `${program.name}: /compact finishes in the background, and its outcome reaches the compaction listeners`,
      async () => {
        const setup = await ports.start(command);
        const threadId = await newChat(setup);
        const mark = streamOf(setup, threadId).length;
        await setup.runtime.request(
          { threadId, method: "prompt", params: { text: "hello" } },
          call(),
        );
        await until(() =>
          streamOf(setup, threadId)
            .slice(mark)
            .find((payload) => payload.kind === "event" && payload.event.type === "prompt_result"),
        );
        const gateway = gatewayFor(setup);
        const compactions: CompactionEvent[] = [];
        gateway.onCompaction((event) => compactions.push(event));

        expect(await gateway.run({ threadId, command: "/compact" })).toMatchObject({
          agentInvoked: false,
        });
        // A chat of one turn is too small for omp to compact: it prints "Compaction failed: Nothing to compact (session
        // too small)" after the run has settled, which is the background result the gateway watches for.
        expect(await until(() => compactions[0])).toEqual({ threadId, outcome: "failed" });
      },
      90_000,
    );
  }
});
