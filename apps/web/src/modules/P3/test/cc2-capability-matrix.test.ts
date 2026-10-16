import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CapabilityMap } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createOmpRuntime } from "@/modules/R0/runtime";
import { ompTransport, renderRun } from "./run-harness";

/** This folder, located from apps/web, where vitest runs. */
const TEST_DIR = resolve(process.cwd(), "src/modules/P3/test");

/**
 * One row per ExternalStore callback in PLAN.md CC2. `installed` is true when P3 puts the callback on the adapter: its
 * handler is in `run.handlers`. `proof` names the full test title in `file`, which must match the title exactly. A row
 * P3 does not install says so in `gate`, and its proof, if any, exercises the behaviour, not an install.
 */
interface CC2Row {
  readonly callback: string;
  readonly installed: boolean;
  readonly gate: string;
  readonly proof: { readonly file: string; readonly test: string } | null;
}

const CC2_MATRIX: readonly CC2Row[] = [
  {
    callback: "onEdit",
    installed: true,
    gate: "omp.cmd.branch: app/root.tsx:711-713 shows the Edit action only while omp can branch; runtime.ts:1128-1130 offers the callback with the same capability",
    proof: {
      file: "edit-and-regenerate.acceptance.test.tsx",
      test: "editing a text-and-image message branches from that message and resends the image, and the source message is unchanged",
    },
  },
  {
    callback: "onReload",
    installed: true,
    gate: "omp.cmd.branch: app/root.tsx:711-713 shows the Regenerate action only while omp can branch; runtime.ts:1128-1130 offers the callback with the same capability",
    proof: {
      file: "edit-and-regenerate.acceptance.test.tsx",
      test: "a regenerate from the answer's user message branches from that message and sends its text and image once",
    },
  },
  {
    callback: "retry",
    installed: true,
    gate: "none: P3's own; a failed run is sent again on the chat it belongs to (runs/handlers.ts:143-153)",
    proof: {
      file: "failure-matrix.test.tsx",
      test: "omp refuses the branch: Try again branches once more and sends the edit once",
    },
  },
  {
    callback: "onCancel",
    installed: false,
    gate: "R0 installs it while omp.cmd.abort (or abort_bash) is available (runtime.ts:1122-1125); P3 installs none",
    proof: null,
  },
  {
    callback: "onRefetchThread",
    installed: false,
    gate: "R0 offers it only with omp.cmd.get_state and omp.cmd.get_entries (runtime.ts:1110-1112, 1126); P3 installs none",
    proof: null,
  },
  {
    callback: "setMessages and messageRepository",
    installed: false,
    gate: "P3 passes its repository to assistant-ui; the repository is not mounted yet (#1715), so it is tested, not installed",
    proof: {
      file: "branch-head.acceptance.test.tsx",
      test: "two sibling answers import parents first, the picked head is persisted, and a reload reads it back",
    },
  },
  {
    callback: "stable parent and head ids",
    installed: false,
    gate: "none: the repository keeps assistant-ui ids apart from omp's entry ids",
    proof: {
      file: "branch-head.acceptance.test.tsx",
      test: "two sibling answers import parents first, the picked head is persisted, and a reload reads it back",
    },
  },
  {
    callback: "optimistic failure",
    installed: false,
    gate: "none: a failed run keeps its text and its source chat (runs/status.ts)",
    proof: {
      file: "failure-matrix.test.tsx",
      test: "omp refuses the prompt after the chat opened: the new chat stays selected, and Try again resends there only",
    },
  },
  {
    callback: "onAddToolResult, approval, onVoiceTranscript and queue",
    installed: false,
    gate: "not P3's: tool, voice and queue rows belong to other modules",
    proof: null,
  },
];

const PROVED = CC2_MATRIX.flatMap((row) =>
  row.proof === null ? [] : [{ callback: row.callback, proof: row.proof }],
);

const BRANCH_AVAILABLE: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.abort": { state: "available", via: "rpc" },
  "omp.cmd.branch": { state: "available", via: "rpc" },
  "omp.cmd.get_branch_messages": { state: "available", via: "rpc" },
};

const BRANCH_UNAVAILABLE: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.abort": { state: "available", via: "rpc" },
};

describe("CC2: the ExternalStore capability matrix for P3", () => {
  test("the handlers P3 returns are exactly the rows it installs", () => {
    const run = renderRun();
    const installed = CC2_MATRIX.filter((row) => row.installed)
      .map((row) => row.callback)
      .sort();

    expect(Object.keys(run.handlers).sort()).toEqual(installed);
  });

  test("every row P3 installs has a proof test", () => {
    const unproved = CC2_MATRIX.filter((row) => row.installed && row.proof === null);

    expect(unproved.map((row) => row.callback)).toEqual([]);
  });

  test.each(PROVED)("$callback is proved by a test titled in its file", ({ proof }) => {
    expect(readFileSync(join(TEST_DIR, proof.file), "utf8")).toContain(`"${proof.test}"`);
  });

  test("the runtime's adapter carries P3's edit and regenerate callbacks only while omp can branch", () => {
    const run = renderRun();
    const send = ompTransport({}).send;

    const branching = createOmpRuntime({
      store: run.store,
      send,
      capabilities: BRANCH_AVAILABLE,
      onEdit: run.handlers.onEdit,
      onReload: run.handlers.onReload,
    }).createAdapter();
    expect(branching.onEdit).toBe(run.handlers.onEdit);
    expect(branching.onReload).toBe(run.handlers.onReload);
    expect(branching.onCancel).toBeTypeOf("function");
    expect(branching.onRefetchThread).toBeUndefined();

    const withoutBranch = createOmpRuntime({
      store: run.store,
      send,
      capabilities: BRANCH_UNAVAILABLE,
      onEdit: run.handlers.onEdit,
      onReload: run.handlers.onReload,
    }).createAdapter();
    expect(withoutBranch.onEdit).toBeUndefined();
    expect(withoutBranch.onReload).toBeUndefined();
  });
});
