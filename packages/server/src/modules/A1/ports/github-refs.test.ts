import { expect, test } from "bun:test";
import type { ServerFrame } from "@omp-app/contracts";
import { CapabilityMap, streamKey } from "@omp-app/contracts";
import { Dispatcher, type DispatcherSocket } from "../../../dispatcher";
import { createPortRegistry } from "../../../registry/ports";
import { EventReplayHub } from "../../../replay";
import type { A1PortContext } from "./context";
import { createGithubRefsRegistration } from "./github-refs";

interface Socket extends DispatcherSocket {
  readonly frames: ServerFrame[];
}

function socket(id: string): Socket {
  const frames: ServerFrame[] = [];
  return { id, frames, send: (frame) => frames.push(frame), close: () => undefined };
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

test("GitHub references handler routes typed calls through Dispatcher", async () => {
  const replay = new EventReplayHub();
  const service = {
    search: async () => ({ candidates: [], truncated: false }),
    currentPullRequest: async () => ({ pullRequest: null }),
  };
  const context = { publish: replay.publish.bind(replay) } as Pick<
    A1PortContext,
    "publish" | "watchStreamActivity"
  >;
  const registration = createGithubRefsRegistration(service as never, context);
  const dispatcher = new Dispatcher({
    registry: createPortRegistry([registration]),
    replay,
    welcome: {
      type: "welcome",
      protocol: "omp-app/1",
      instanceId: "github-handler",
      serverVersion: "test",
      omp: null,
      capabilities: CapabilityMap.parse({}),
    },
  });
  const client = socket("github-client");
  const session = dispatcher.open(client);
  session.receive(
    JSON.stringify({
      type: "hello",
      protocols: ["omp-app/1"],
      client: { name: "github-handler", version: "1.0.0" },
    }),
  );
  session.receive(
    JSON.stringify({
      type: "call",
      id: "search",
      port: "A1.githubRefs",
      method: "search",
      args: { folder: "/workspace", query: "bug", kind: "issue", limit: 5 },
    }),
  );
  session.receive(
    JSON.stringify({
      type: "call",
      id: "current",
      port: "A1.githubRefs",
      method: "currentPullRequest",
      args: { folder: "/workspace" },
    }),
  );
  await settle();
  expect(result(client, "search")).toMatchObject({
    ok: true,
    value: { candidates: [], truncated: false },
  });
  expect(result(client, "current")).toMatchObject({ ok: true, value: { pullRequest: null } });
  expect(streamKey("A1.githubRefs", "search")).toBe("A1.githubRefs/search");
});
