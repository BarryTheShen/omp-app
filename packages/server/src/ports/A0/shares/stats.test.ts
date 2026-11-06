import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpStats } from "./stats";

/**
 * A stand-in for `omp stats`: it serves a page on a port of the system's choosing, names it in colour as omp does, and
 * keeps writing after that (a pipe closed on it would stop it).
 */
const STAND_IN = `
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("stats page") });
console.log("Syncing…");
console.log("\\x1b[32mDashboard available at: http://127.0.0.1:" + server.port + "\\x1b[39m");
console.log("Press ctrl+c to stop");
setInterval(() => console.log("still here"), 20);
`;

/** A stand-in that ends before it names a page. */
const BROKEN = `console.log("no page today"); process.exit(3);`;

const started: OmpStats[] = [];
let directory = "";

async function standIn(source: string): Promise<OmpStats> {
  directory = await mkdtemp(join(tmpdir(), "omp-stats-"));
  const script = join(directory, "omp.ts");
  await writeFile(script, source);
  const stats = new OmpStats({
    command: [process.execPath, script],
    env: { PATH: process.env.PATH ?? "" },
    startMs: 10_000,
  });
  started.push(stats);
  return stats;
}

const answers = (port: number): Promise<string | null> =>
  fetch(`http://127.0.0.1:${port}/`)
    .then((response) => response.text())
    .catch(() => null);

afterEach(async () => {
  for (const stats of started.splice(0)) stats.stop();
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

describe("omp's statistics page (#2836 D6)", () => {
  test("starts once, answers on the port omp names, keeps running while omp writes on, and stops", async () => {
    const stats = await standIn(STAND_IN);
    const port = await stats.start();
    expect(port).toBeGreaterThan(0);
    expect(await answers(port)).toBe("stats page");

    // Asked again, the same page: no second omp.
    expect(await stats.start()).toBe(port);
    // omp keeps writing; its output is read on, so it still runs.
    await Bun.sleep(400);
    expect(await answers(port)).toBe("stats page");

    stats.stop();
    let gone = false;
    for (let tries = 0; tries < 40 && !gone; tries += 1) {
      gone = (await answers(port)) === null;
      if (!gone) await Bun.sleep(50);
    }
    expect(gone).toBe(true);
  }, 20_000);

  test("an omp that ends before naming a page is a failure to start", async () => {
    const stats = await standIn(BROKEN);
    await expect(stats.start()).rejects.toThrow("omp's statistics page did not start.");
  }, 20_000);
});
