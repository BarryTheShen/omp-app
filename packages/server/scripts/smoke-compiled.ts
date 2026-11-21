/**
 * Starts the compiled app's command (`build-server.ts`, with the chat host beside it) in a throwaway home and checks it
 * serves: `--version` prints the version it was built with, and a start prints its address, whose root page answers.
 * The platforms workflow runs it on macOS and Windows after building both programs there.
 *
 *   bun packages/server/scripts/smoke-compiled.ts <folder holding omp-app and chat-host> <version>
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [folder, version] = process.argv.slice(2);
if (folder === undefined || version === undefined) {
  console.error("usage: bun packages/server/scripts/smoke-compiled.ts <folder> <version>");
  process.exit(2);
}
const program = join(folder, process.platform === "win32" ? "omp-app.exe" : "omp-app");

const printed = Bun.spawnSync([program, "--version"]).stdout.toString().trim();
if (printed !== version) throw new Error(`--version printed "${printed}", not "${version}"`);
console.log(`--version: ${printed}`);

// A throwaway home and a stand-in web app: this checks that the server starts and serves, not the page itself.
const root = await mkdtemp(join(tmpdir(), "omp-app-smoke-"));
const home = join(root, "home");
const ui = join(root, "ui");
await mkdir(home, { recursive: true });
await mkdir(ui, { recursive: true });
await writeFile(join(ui, "index.html"), "<!doctype html><title>smoke</title>smoke page");
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("OMP_APP_") && !key.startsWith("XDG_"))
    env[key] = value;
}
Object.assign(env, { HOME: home, USERPROFILE: home, OMP_APP_UI_ROOT: ui });

const child = Bun.spawn([program, "--no-open", "--port", "0"], {
  env,
  stdout: "pipe",
  stderr: "pipe",
});
// A start that prints no address in time fails the check; the timer is cleared after, so this script ends with the check.
const tooLong = setTimeout(() => {
  console.error("no address within 60 s");
  child.kill();
  process.exit(1);
}, 60_000);
try {
  let text = "";
  let address: string | undefined;
  for await (const chunk of child.stdout) {
    text += new TextDecoder().decode(chunk);
    address = /http:\/\/127\.0\.0\.1:[0-9]+/.exec(text)?.[0];
    if (address !== undefined) break;
  }
  if (address === undefined) {
    throw new Error(
      `the server ended without an address: ${text}${await new Response(child.stderr).text()}`,
    );
  }
  const page = await (await fetch(`${address}/`)).text();
  if (!page.includes("smoke page"))
    throw new Error(`the root page was not the web app's: ${page.slice(0, 200)}`);
  console.log(`started and served at ${address}`);
} finally {
  clearTimeout(tooLong);
  child.kill();
  await child.exited;
}
