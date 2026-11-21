/**
 * Starts the built desktop window (`cargo tauri build`'s program, beside its resources) in a throwaway home and checks
 * it starts its server: the server records itself in `<home>/.local/state/omp-app/instance.json`, and its page loads.
 * The platforms workflow runs it on macOS and Windows after packaging/build-desktop-bundle.sh.
 *
 *   bun packaging/smoke-desktop.ts <the window's program>
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [program] = process.argv.slice(2);
if (program === undefined || !existsSync(program)) {
  console.error("usage: bun packaging/smoke-desktop.ts <the window's program>");
  process.exit(2);
}

const home = await mkdtemp(join(tmpdir(), "omp-app-desktop-smoke-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("OMP_APP_") && !key.startsWith("XDG_"))
    env[key] = value;
}
Object.assign(env, { HOME: home, USERPROFILE: home });
const record = join(home, ".local", "state", "omp-app", "instance.json");

const window = Bun.spawn([program], { env, stdout: "inherit", stderr: "inherit" });
let server: number | undefined;
try {
  const deadline = Date.now() + 150_000;
  let address: string | undefined;
  while (Date.now() < deadline && window.exitCode === null) {
    if (existsSync(record)) {
      const kept = JSON.parse(await readFile(record, "utf8")) as { pid?: number; url?: string };
      server = kept.pid;
      const url = kept.url?.split("#")[0];
      if (
        url !== undefined &&
        (await fetch(url).then(
          (answer) => answer.ok,
          () => false,
        ))
      ) {
        address = url;
        break;
      }
    }
    await Bun.sleep(1_000);
  }
  if (address === undefined) {
    await explain();
    throw new Error(
      window.exitCode === null
        ? "the window started no server that answered within 150 s"
        : `the window ended (exit ${window.exitCode}) before its server answered`,
    );
  }
  console.log(`the window started its server, which serves its page at ${address}`);
} finally {
  window.kill();
  // The window leaves its server running, as it does for a person; this check stops it.
  if (server !== undefined) {
    try {
      process.kill(server);
    } catch {
      // It has ended already.
    }
  }
  await window.exited;
}

/**
 * What a failed start leaves to go on, since a windowed program on Windows has no console for its own messages: what
 * the home holds, the server's record and what its address answers, the end of the server's log, and the resources
 * beside the window's program.
 */
async function explain(): Promise<void> {
  const list = async (folder: string, depth: number): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      found.push(join(folder, entry.name));
      if (entry.isDirectory() && depth > 0)
        found.push(...(await list(join(folder, entry.name), depth - 1)));
    }
    return found;
  };
  console.error(`the home holds:\n  ${(await list(home, 4)).join("\n  ")}`);
  if (existsSync(record)) {
    const text = await readFile(record, "utf8");
    console.error(`the server's record: ${text.replace(/#token=[^"]*/, "#token=…")}`);
    const url = (JSON.parse(text) as { url?: string }).url?.split("#")[0];
    if (url !== undefined) {
      const answer = await fetch(url).then(
        (response) => `HTTP ${response.status} ${response.headers.get("content-type") ?? ""}`,
        (error: unknown) => `no answer: ${String(error)}`,
      );
      console.error(`its address ${url} gives: ${answer}`);
    }
  }
  const log = join(home, ".local", "state", "omp-app", "omp-app.log");
  if (existsSync(log)) {
    const lines = (await readFile(log, "utf8")).trimEnd().split("\n");
    console.error(`the end of the server's log:\n${lines.slice(-40).join("\n")}`);
  }
  const resources = dirname(resolve(program as string));
  const beside = (await readdir(resources)).filter(
    (name) => !name.endsWith(".d") && !name.endsWith(".pdb"),
  );
  console.error(`beside the window's program: ${beside.join(", ")}`);
}
