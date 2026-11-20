import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppUpdates } from "@omp-app/contracts";
import { AppUpdater, type AppUpdaterOptions } from "./app-updates";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const DEB = Buffer.from("the package of 0.3.1700");
const SUM = createHash("sha256").update(DEB).digest("hex");
const RELEASE = "https://github.com/BarryTheShen/omp-app/releases/download/v0.3.1700";

/** GitHub as the updater sees it: the newest release, and its files; counts the looks for the newest. */
function github(files: Record<string, string | Buffer> = {}) {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    asked.push(url);
    if (url.endsWith("/releases/latest")) {
      return Response.json({ tag_name: "v0.3.1700", published_at: "2026-11-20T20:00:00Z" });
    }
    const body = files[url];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  };
  return { asked, fetch };
}

/** The server's computer: what each command answers, and the commands run. */
function computer(answers: Record<string, { code: number; output: string }> = {}) {
  const ran: string[][] = [];
  const run = async (command: string, args: readonly string[]) => {
    ran.push([command, ...args]);
    return (
      answers[command] ??
      (command === "dpkg-query" ? { code: 0, output: "0.3.1684" } : { code: 0, output: "" })
    );
  };
  return { ran, run };
}

async function updater(overrides: Partial<AppUpdaterOptions> = {}) {
  dir ??= await mkdtemp(join(tmpdir(), "omp-app-updates-"));
  let now = Date.parse("2026-11-20T21:00:00Z");
  const options: AppUpdaterOptions = {
    dir: join(dir, "updates"),
    installed: "0.3.1684",
    fetch: github().fetch,
    run: computer().run,
    cgroup: async () =>
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/omp-app.service\n",
    now: () => new Date(now),
    ...overrides,
  };
  return { updater: new AppUpdater(options), options, later: (ms: number) => (now += ms) };
}

test("the newest release is looked up at most hourly unless asked, and what the server shows fits the contract", async () => {
  const hub = github();
  const { updater: one, later } = await updater({ fetch: hub.fetch });
  const first = await one.read();
  expect(AppUpdates.parse(first)).toEqual(first);
  expect(first).toMatchObject({
    installed: "0.3.1684",
    latest: { version: "0.3.1700", at: "2026-11-20T20:00:00Z" },
    install: { possible: true },
    job: null,
    last: null,
  });
  await one.read();
  expect(hub.asked).toHaveLength(1);
  await one.read({ check: true });
  expect(hub.asked).toHaveLength(2);
  later(60 * 60_000);
  await one.read();
  expect(hub.asked).toHaveLength(3);
});

test("a failed look says why and keeps the server usable", async () => {
  const { updater: one } = await updater({ fetch: async () => new Response("", { status: 403 }) });
  expect(await one.read()).toMatchObject({
    latest: null,
    checkProblem: "The newest release could not be looked up: GitHub answered 403.",
  });
});

test("it installs only as the installed package in the omp-app service, with sudo, and while omp's update is not under way", async () => {
  const refused = async (overrides: Partial<AppUpdaterOptions>) =>
    (await (await updater(overrides)).updater.read()).install;
  expect(await refused({ installed: "0.0.0-dev" })).toEqual({
    possible: false,
    reason: "This server is a development build: it does not update itself.",
  });
  expect(await refused({ cgroup: async () => "0::/user.slice/session-3.scope\n" })).toMatchObject({
    possible: false,
    reason: expect.stringContaining("does not run as the omp-app service"),
    command: expect.stringContaining("omp-app_0.3.1700_amd64.deb && sudo apt install"),
  });
  expect(
    await refused({ run: computer({ "dpkg-query": { code: 0, output: "0.3.1600" } }).run }),
  ).toMatchObject({ possible: false, reason: "This server is not the installed omp-app package." });
  expect(
    await refused({ run: computer({ sudo: { code: 1, output: "a password is required" } }).run }),
  ).toMatchObject({
    possible: false,
    reason: expect.stringContaining("sudo without a password"),
  });
  const ompStatus = join(dir ?? "", "omp-update.json");
  await writeFile(ompStatus, JSON.stringify({ version: 1, pending: "omp 19.0.1" }));
  expect(await refused({ ompStatus })).toMatchObject({
    possible: false,
    reason: expect.stringContaining("omp's update is under way or waiting (omp 19.0.1)"),
  });
});

test("Update downloads the package, checks it, keeps the way back, and hands the install to a unit outside the service", async () => {
  const hub = github({
    [`${RELEASE}/SHA256SUMS`]: `${SUM}  omp-app_0.3.1700_amd64.deb\n`,
    [`${RELEASE}/omp-app_0.3.1700_amd64.deb`]: DEB,
  });
  const machine = computer();
  const { updater: one, options } = await updater({ fetch: hub.fetch, run: machine.run });
  // An older download goes; the running release's folder stays for Go back.
  await mkdir(join(options.dir, "v0.3.1500"), { recursive: true });
  await mkdir(join(options.dir, "v0.3.1684"), { recursive: true });
  expect((await one.update("0.3.1700")).job).toMatchObject({
    version: "0.3.1700",
    step: "downloading",
  });
  await Bun.sleep(50);
  expect((await one.read()).job).toMatchObject({ version: "0.3.1700", step: "installing" });
  expect(await readFile(join(options.dir, "v0.3.1700", "omp-app_0.3.1700_amd64.deb"))).toEqual(DEB);
  expect((await readdir(options.dir)).sort()).toEqual(["last.json", "v0.3.1684", "v0.3.1700"]);
  expect(JSON.parse(await readFile(join(options.dir, "last.json"), "utf8"))).toMatchObject({
    from: "0.3.1684",
    to: "0.3.1700",
  });
  const unit = machine.ran.find((each) => each[0] === "systemd-run");
  expect(unit?.slice(0, 2)).toEqual(["systemd-run", "--user"]);
  expect(unit).toContain("--collect");
  expect(unit?.at(-4)).toBe(join(options.dir, "v0.3.1700", "omp-app_0.3.1700_amd64.deb"));
  expect(unit?.join(" ")).toContain("systemctl --user restart omp-app.service");
  // One at a time.
  await expect(one.update("0.3.1700")).rejects.toThrow(
    "omp-app 0.3.1700 is being installed already.",
  );
});

test("a package that does not match the release's checksum is never installed", async () => {
  const hub = github({
    [`${RELEASE}/SHA256SUMS`]: `${"0".repeat(64)}  omp-app_0.3.1700_amd64.deb\n`,
    [`${RELEASE}/omp-app_0.3.1700_amd64.deb`]: DEB,
  });
  const machine = computer();
  const { updater: one } = await updater({ fetch: hub.fetch, run: machine.run });
  await one.update("0.3.1700");
  await Bun.sleep(50);
  expect((await one.read()).job).toMatchObject({
    step: "failed",
    detail: expect.stringContaining("does not match the release's checksum: nothing was installed"),
  });
  expect(machine.ran.some((each) => each[0] === "systemd-run")).toBe(false);
});

test("after the restart the server shows the update that brought it; an install that failed shows why", async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-app-updates-"));
  const updates = join(dir, "updates");
  await mkdir(updates, { recursive: true });
  await writeFile(
    join(updates, "last.json"),
    JSON.stringify({ version: 1, from: "0.3.1600", to: "0.3.1684", at: "2026-11-20T20:59:00Z" }),
  );
  expect((await (await updater()).updater.read()).last).toEqual({
    from: "0.3.1600",
    to: "0.3.1684",
    at: "2026-11-20T20:59:00Z",
  });
  await writeFile(join(updates, "failed.json"), JSON.stringify({ version: 1, to: "0.3.1700" }));
  await writeFile(
    join(updates, "install-0.3.1700.log"),
    "Reading package lists...\nE: dpkg was interrupted\n",
  );
  expect((await (await updater()).updater.read()).job).toMatchObject({
    version: "0.3.1700",
    step: "failed",
    detail: expect.stringContaining("E: dpkg was interrupted"),
  });
});
