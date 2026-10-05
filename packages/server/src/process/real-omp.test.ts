import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderPath, ThreadId } from "@omp-app/contracts";
import { RpcSession } from "@omp-app/omp-rpc";
import { type OmpProcess, spawnOmpProcess } from "./omp-process";

// Starting the real omp takes seconds and varies under load (it timed out while ten builders ran
// their checks), so this smoke runs only when asked: OMP_APP_REAL_OMP=1. A0.9's end-to-end suite
// exercises the real omp at every wave gate.
const REAL_OMP = process.env.OMP_APP_REAL_OMP === "1" ? Bun.which("omp") : null;
const realTest = REAL_OMP ? test : test.skip;
const temporaryRoots: string[] = [];
const liveProcesses: OmpProcess[] = [];

afterEach(async () => {
  await Promise.all(
    liveProcesses.splice(0).map((process) => process.stop().catch(() => undefined)),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

realTest(
  "starts omp in an isolated HOME/agent dir and completes get_state through RpcSession",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-app-a0-5-real-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const folder = FolderPath.parse(join(root, "workspace"));
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(folder, { recursive: true }),
    ]);
    const fakeKey = ["sk", "ant", "k".repeat(30)].join("-");
    const process = spawnOmpProcess({
      threadId: ThreadId.parse("thread-a0-5-real"),
      folder,
      ompBin: REAL_OMP ?? "omp",
      env: {
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        ANTHROPIC_API_KEY: fakeKey,
      },
    });
    liveProcesses.push(process);
    const session = new RpcSession(process);

    await process.start();
    await session.start();
    const state = await session.send({ type: "get_state" });

    expect(process.status).toBe("running");
    expect(process.processId).toBeDefined();
    expect(state.sessionFile).toContain(agentDir);
    await session.close();
  },
);
