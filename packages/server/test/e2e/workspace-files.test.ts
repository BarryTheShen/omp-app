import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAppClient, type WebSocketLike } from "@omp-app/client";
import {
  type FileHash,
  type FolderPath,
  type WorkspaceFileChanged,
  WorkspaceFilesPort,
  type WorkspaceRelativePath,
} from "@omp-app/contracts";
import { CHAT_HOST_METHODS } from "@omp-app/contracts/chat-host";
import { type CompositionServer, createCompositionServer } from "../../scripts/dev";

const dataRoot = resolve(import.meta.dir, "../../../../../.data");
const roots: string[] = [];
const servers: CompositionServer[] = [];

// As the file-watch test's fake: omp's command line for the start-up checks, and a chat host that says hello.
const FAKE_OMP = `#!/usr/bin/env bun
if (Bun.argv.includes("--version")) {
  process.stdout.write("omp 18.6.1\\n");
  process.exit(0);
}
if (Bun.argv.slice(-3).join(" ") === "config list --json") {
  process.stdout.write(JSON.stringify({ model: { type: "string", value: "fake-default" } }));
  process.exit(0);
}
if (!Bun.argv.includes("__omp_app_chat")) process.exit(2);
console.log(JSON.stringify({
  kind: "hello",
  protocol: 1,
  ompVersion: "18.6.1",
  methods: ${JSON.stringify(CHAT_HOST_METHODS)},
  session: { id: "thread-workspace-files", file: process.cwd() + "/session.jsonl", cwd: process.cwd() },
}));
for await (const _chunk of Bun.stdin.stream()) {
  // A chat host reads requests until it is stopped; the check sends none.
}
`;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startServer(): Promise<{ server: CompositionServer; folder: FolderPath }> {
  await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, "workspace-files-server-"));
  roots.push(root);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const appDataDir = join(root, "app-data");
  const folder = join(root, "work") as FolderPath;
  await Promise.all([
    mkdir(home),
    mkdir(agentDir),
    mkdir(appDataDir),
    mkdir(join(folder, "notes"), { recursive: true }),
  ]);
  await writeFile(join(folder, "notes", "plan.md"), "# Plan\n");
  const ompBin = join(root, "fake-omp");
  await writeFile(ompBin, FAKE_OMP, { mode: 0o755 });
  await chmod(ompBin, 0o755);
  const server = await createCompositionServer({
    port: 0,
    env: { ...Bun.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, OMP_APP_DATA_DIR: appDataDir },
    homeDir: home,
    agentDir,
    appDataDir,
    ompBin,
    staticRoot: resolve(import.meta.dir, "../../../../apps/web/dist"),
  });
  servers.push(server);
  return { server, folder };
}

function clientFor(server: CompositionServer) {
  const webSocketFactory = (socketUrl: string): WebSocketLike =>
    new WebSocket(socketUrl, { headers: { Origin: server.url } }) as unknown as WebSocketLike;
  return createAppClient({
    url: `ws://127.0.0.1:${server.port}/ws`,
    token: server.token,
    webSocketFactory,
    reconnect: { maxAttempts: 1 },
  });
}

describe("the Files port through the production server (#2782)", () => {
  test("lists, reads and saves a file over the socket, and tells an outside change within a second", async () => {
    const { server, folder } = await startServer();
    const client = clientFor(server);
    const files = client.port(WorkspaceFilesPort);
    const plan = "notes/plan.md" as WorkspaceRelativePath;

    const root = await files.list({ folder, showIgnored: false });
    expect(root.entries).toContainEqual(
      expect.objectContaining({ name: "notes", kind: "directory" }),
    );
    const read = await files.read({ folder, path: plan, offset: 0, length: 1024 });
    expect(Buffer.from(read.bytes, "base64").toString()).toBe("# Plan\n");

    const opened = await files.stat({ folder, path: plan });
    const { uploadId } = await files.beginWrite({
      folder,
      path: plan,
      expectedHash: opened.hash as FileHash,
    });
    await files.writeChunk({
      uploadId,
      offset: 0,
      bytes: Buffer.from("# Plan\n\n- ship\n").toString("base64"),
    });
    await files.commit({ uploadId });
    expect(await readFile(join(folder, "notes", "plan.md"), "utf8")).toBe("# Plan\n\n- ship\n");

    const heard: WorkspaceFileChanged[] = [];
    const subscription = await client.subscribe(WorkspaceFilesPort, "changed", { scope: folder });
    subscription.onEvent((payload) => heard.push(payload));
    await files.watch({ folder, paths: ["", "notes" as WorkspaceRelativePath] });

    const appended = performance.now();
    await appendFile(join(folder, "notes", "plan.md"), "- from outside\n");
    while (!heard.some((event) => event.path === plan) && performance.now() - appended < 1000) {
      await Bun.sleep(20);
    }
    expect(heard).toContainEqual({ folder, path: plan, change: "modified" });
    expect(performance.now() - appended).toBeLessThan(1000);

    await subscription.unsubscribe();
    client.dispose();
  }, 60_000);
});
