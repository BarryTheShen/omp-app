import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderPath, ThreadId } from "@omp-app/contracts";
import { ChatHostClient } from "../chat-host/client";
import { chatHostCommand } from "../omp-host/chat-command";
import { type OmpProcess, spawnOmpProcess } from "./omp-process";

// Starting a real chat (omp's command line, built from the pinned package) takes seconds and varies under load (it timed out while ten
// builders ran their checks), so this smoke runs only when asked: OMP_APP_REAL_OMP=1. A0.9's end-to-end suite exercises
// real chats at every wave gate.
const realTest = process.env.OMP_APP_REAL_OMP === "1" ? test : test.skip;
const temporaryRoots: string[] = [];
const liveProcesses: OmpProcess[] = [];

/**
 * The `cwd` of the session record omp writes into its session file. omp puts a title record first, then the
 * session record, and writes the file in real time, so the wait is real time too.
 */
async function waitForSessionCwd(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const text = await readFile(path, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      try {
        const record: { type?: unknown; cwd?: unknown } = JSON.parse(line);
        if (record.type === "session") return record.cwd;
      } catch {
        // A line omp is still writing is not complete JSON yet.
      }
    }
    await Bun.sleep(50);
  }
  throw new Error(`omp wrote no session record to ${path} within 10 seconds`);
}

afterEach(async () => {
  await Promise.all(
    liveProcesses.splice(0).map((process) => process.stop().catch(() => undefined)),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

realTest(
  "starts the chat host in an isolated HOME/agent dir and reads its state through the chat host client",
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
      homeDir: home,
      chatCommand: chatHostCommand(),
      env: {
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        ANTHROPIC_API_KEY: fakeKey,
      },
    });
    liveProcesses.push(process);
    const client = new ChatHostClient(process);

    await process.start();
    await client.hello;
    const state = await client.request("get_state", {});

    expect(process.status).toBe("running");
    expect(process.processId).toBeDefined();
    expect(state.sessionFile).toContain(agentDir);
    client.dispose();
  },
);

realTest(
  "a chat in the home folder runs in it, and its session records that folder as its cwd (issue 1143)",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-app-1143-real-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(agentDir, { recursive: true })]);
    const folder = FolderPath.parse(home);
    const process = spawnOmpProcess({
      threadId: ThreadId.parse("thread-1143-home"),
      folder,
      homeDir: home,
      chatCommand: chatHostCommand(),
      env: {
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        ANTHROPIC_API_KEY: ["sk", "ant", "k".repeat(30)].join("-"),
      },
    });
    liveProcesses.push(process);
    const client = new ChatHostClient(process);

    await process.start();
    await client.hello;
    const state = await client.request("get_state", {});
    // omp saves the first message as it admits it; the placeholder key makes the model reply an error, which is not the point here.
    await client.request("prompt", { text: "hello" }).catch(() => undefined);

    const workingFolder = await readlink(`/proc/${process.pid}/cwd`);
    expect(workingFolder).toBe(await realpath(home));
    const sessionFile = state.sessionFile;
    if (sessionFile === undefined) throw new Error("omp reported no session file");
    expect(await waitForSessionCwd(sessionFile)).toBe(await realpath(home));
    client.dispose();
  },
);
