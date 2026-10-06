import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SessionInfoState } from "../../R0/store";
import type {
  SessionInfoMetadata,
  SessionInfoMetadataSource,
  SessionInfoRuntimeSnapshot,
  SessionInfoRuntimeSource,
} from "../contract";
import { SessionInfoModel } from "./info";

const threadId = "d5-info-thread" as ThreadId;
const baseSession: SessionInfoState = {
  model: null,
  thinkingLevel: "medium",
  sessionName: null,
  contextUsage: null,
  isCompacting: false,
  autoCompactionEnabled: true,
  tokensPerSecond: 12,
  goal: null,
  revision: 1,
};
const metadata: SessionInfoMetadata = {
  id: threadId,
  title: "Catalog title",
  cwd: "/workspace/project" as SessionInfoMetadata["cwd"] & string,
  sessionFile: "/workspace/project/.omp/d5.jsonl" as SessionInfoMetadata["sessionFile"] & string,
};

function sources(initialSession: SessionInfoState = baseSession) {
  let runtimeSnapshot: SessionInfoRuntimeSnapshot = {
    threadId,
    session: initialSession,
  };
  let metadataSnapshot: SessionInfoMetadata | null = metadata;
  const runtimeListeners = new Set<() => void>();
  const metadataListeners = new Set<() => void>();
  const runtime: SessionInfoRuntimeSource = {
    getSnapshot: () => runtimeSnapshot,
    subscribe: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
  };
  const metadataSource: SessionInfoMetadataSource = {
    getSnapshot: () => metadataSnapshot,
    subscribe: (listener) => {
      metadataListeners.add(listener);
      return () => metadataListeners.delete(listener);
    },
  };
  return {
    runtime,
    metadata: metadataSource,
    setSession(session: SessionInfoState) {
      runtimeSnapshot = { ...runtimeSnapshot, session };
      for (const listener of runtimeListeners) listener();
    },
    setMetadata(next: SessionInfoMetadata | null) {
      metadataSnapshot = next;
      for (const listener of metadataListeners) listener();
    },
    setThreadId(next: ThreadId) {
      runtimeSnapshot = { ...runtimeSnapshot, threadId: next };
      for (const listener of runtimeListeners) listener();
    },
  };
}

describe("SessionInfoModel", () => {
  test("projects R0 snapshot.session and uses catalog metadata only for missing fields", () => {
    const input = sources();
    const model = new SessionInfoModel(input);
    const first = model.getSnapshot();

    expect(first.id).toBe(threadId);
    expect(first.title).toBe("Catalog title");
    expect(first.cwd).toBe(metadata.cwd);
    expect(first.session).toBe(baseSession);
    expect(first.session.thinkingLevel).toBe("medium");
    expect(model.getSnapshot()).toBe(first);

    const liveSession = { ...baseSession, sessionName: "Live omp name", revision: 2 };
    input.setSession(liveSession);
    const second = model.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.title).toBe("Live omp name");
    expect(second.session).toBe(liveSession);
    expect(second.session.revision).toBe(2);
    model.dispose();
  });

  test("does not attach catalog metadata from a different selected session", () => {
    const input = sources();
    const model = new SessionInfoModel(input);

    input.setThreadId("next-thread" as ThreadId);
    expect(model.getSnapshot()).toMatchObject({
      id: "next-thread",
      title: null,
      cwd: null,
      sessionFile: null,
      session: baseSession,
    });
    model.dispose();
  });

  test("updates metadata independently and cleans up both source subscriptions", () => {
    const input = sources();
    const model = new SessionInfoModel(input);
    const seen: string[] = [];
    const stop = model.subscribe((snapshot) => seen.push(snapshot.cwd ?? "none"));

    input.setMetadata(null);
    expect(model.getSnapshot().cwd).toBeNull();
    expect(seen).toEqual(["none"]);
    stop();
    model.dispose();
    input.setMetadata(metadata);
    input.setSession({ ...baseSession, revision: 3 });
    expect(seen).toEqual(["none"]);
    expect(() => model.getSnapshot()).toThrow("disposed");
  });
});
