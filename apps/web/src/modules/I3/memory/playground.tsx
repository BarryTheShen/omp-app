import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { OverlayHost } from "@/overlay";
import type { MemoryStoreAdapter } from "../ports";
import { useMemoryCenter } from "./controller";
import { MemoryCenterPanel } from "./panel";

const root = document.getElementById("i3-2-memory-playground-root");
if (!root) throw new Error("The I3.2 memory playground root is missing.");
const playgroundRoot: HTMLElement = root;

const threadId = ThreadId.parse("i3-2-playground-thread");
const folder = FolderPath.parse("/workspace/project");
playgroundRoot.dataset.clearCalls = "0";
const entry = {
  id: "0123456789abcdef" as const,
  scope: "project" as const,
  folder,
  threadId,
  namespace: "project",
  content: "Keep release notes short and factual.",
  metadata: { source: "playground" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sensitive: false,
};

function fakeAdapter(): MemoryStoreAdapter {
  let conflict = true;
  let current: typeof entry | undefined = entry;
  let revision = "r1";
  return {
    list: async () => ({
      parsed: true,
      rawText: "",
      entries: current ? [current] : [],
      nextCursor: null,
      revision,
    }),
    get: async () => ({ parsed: true, rawText: "", entry: current ?? null }),
    write: async (args) => {
      if (args.expectedRevision !== revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Memory changed elsewhere.",
          retryable: true,
        });
      }
      if (conflict) {
        conflict = false;
        current = { ...entry, content: "Newer memory from elsewhere." };
        revision = "r2";
        throw new AppFailure({
          code: "conflict",
          message: "Memory changed elsewhere.",
          retryable: true,
        });
      }
      current = {
        ...entry,
        content: args.content,
        updatedAt: "2026-01-02T00:00:00.000Z",
      };
      revision = "r3";
      return { parsed: true, rawText: "", entry: current, revision, previousRevision: "r2" };
    },
    delete: async () => {
      current = undefined;
      revision = "r4";
      return { parsed: true, rawText: "", revision };
    },
    clear: async () => {
      playgroundRoot.dataset.clearCalls = String(
        Number(playgroundRoot.dataset.clearCalls ?? 0) + 1,
      );
      revision = "r4";
      return {
        parsed: true,
        rawText: "Memory cleared.",
        revision,
        deletedCount: 0,
      };
    },
    subscribeChanged: () => () => undefined,
  };
}

function Playground() {
  const adapter = useMemo(() => fakeAdapter(), []);
  const controller = useMemoryCenter({
    adapter,
    folder,
    threadId,
    open: true,
    runCommand: async ({ command }) => {
      if (command === "diagnose") {
        throw new AppFailure({
          code: "timeout",
          message: "Memory diagnostics timed out.",
          retryable: true,
        });
      }
      return {
        command,
        status: "complete",
        message:
          command === "stats"
            ? "Memory statistics are ready."
            : command === "enqueue"
              ? "Memory consolidation enqueued."
              : "Memory maintenance completed.",
      };
    },
  });
  return <MemoryCenterPanel controller={controller} />;
}

createRoot(playgroundRoot).render(
  <OverlayHost>
    <Playground />
  </OverlayHost>,
);
