import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "@omp-app/contracts";
import { CapabilityMap, streamKey } from "@omp-app/contracts";
import { Dispatcher, type DispatcherSocket } from "../../../dispatcher";
import { createPortRegistry } from "../../../registry/ports";
import { EventReplayHub } from "../../../replay";
import type { A1PortContext } from "./context";
import { createRuleStoreRegistration } from "./rule-store";

interface Socket extends DispatcherSocket {
  readonly frames: ServerFrame[];
}

function socket(id: string): Socket {
  const frames: ServerFrame[] = [];
  return { id, frames, send: (frame) => frames.push(frame), close: () => undefined };
}

function hello(session: { receive(frame: string): void }): void {
  session.receive(
    JSON.stringify({
      type: "hello",
      protocols: ["omp-app/1"],
      client: { name: "rule-handler-test", version: "1.0.0" },
    }),
  );
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function result(
  socketValue: Socket,
  id: string,
): Extract<ServerFrame, { type: "result" }> | undefined {
  return socketValue.frames.find(
    (frame): frame is Extract<ServerFrame, { type: "result" }> =>
      frame.type === "result" && frame.id === id,
  );
}

function events(socketValue: Socket): Extract<ServerFrame, { type: "event" }>[] {
  return socketValue.frames.filter(
    (frame): frame is Extract<ServerFrame, { type: "event" }> => frame.type === "event",
  );
}

describe("A1.15 RuleStore handler", () => {
  test("routes calls and scoped change events through Dispatcher", async () => {
    const replay = new EventReplayHub();
    const listeners = new Set<(change: unknown) => void>();
    const rule = {
      id: "rule.md",
      name: "rule",
      scope: "project" as const,
      content: "body",
      enabled: true,
      source: "project" as const,
      revision: "revision-1",
    };
    const ruleStore = {
      list: async () => ({ rules: [rule], revision: "revision-1" }),
      read: async () => rule,
      write: async () => ({ rule, revision: "revision-1", previousRevision: "revision-0" }),
      delete: async () => ({ deleted: true as const, revision: "revision-2" }),
      subscribe: (_scope: unknown, listener: (change: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const context = {
      publish: (stream: Parameters<EventReplayHub["publish"]>[0], payload: unknown) =>
        replay.publish(stream, payload),
      watchStreamActivity: (
        prefix: string,
        listener: Parameters<EventReplayHub["registerStreamActivity"]>[1],
      ) => replay.registerStreamActivity(prefix, listener),
    } as Pick<A1PortContext, "publish" | "watchStreamActivity">;
    const registration = createRuleStoreRegistration(ruleStore as never, context);
    const dispatcher = new Dispatcher({
      registry: createPortRegistry([registration]),
      replay,
      welcome: {
        type: "welcome",
        protocol: "omp-app/1",
        instanceId: "rule-handler",
        serverVersion: "test",
        omp: null,
        capabilities: CapabilityMap.parse({}),
      },
    });
    const client = socket("rule-client");
    const session = dispatcher.open(client);
    hello(session);
    session.receive(
      JSON.stringify({
        type: "call",
        id: "list",
        port: "A1.ruleStore",
        method: "list",
        args: { scope: "project", folder: "/workspace" },
      }),
    );
    await settle();
    expect(result(client, "list")).toMatchObject({
      ok: true,
      value: { rules: [{ id: "rule.md" }] },
    });

    const stream = streamKey("A1.ruleStore", "changed", "folder:/workspace");
    session.receive(JSON.stringify({ type: "subscribe", id: "sub", stream }));
    await settle();
    expect(listeners.size).toBe(1);
    for (const listener of listeners) {
      listener({
        folder: "/workspace",
        scope: "project",
        id: "rule.md",
        revision: "revision-2",
        reason: "filesystem",
      });
    }
    await settle();
    expect(events(client)).toMatchObject([
      { stream, payload: { id: "rule.md", revision: "revision-2" } },
    ]);
    session.receive(JSON.stringify({ type: "unsubscribe", id: "unsub", stream }));
    expect(listeners.size).toBe(0);
  });
});
