import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACH_POLL_MS,
  ATTACH_WAIT_MS,
  clearInstance,
  instanceFile,
  launchAddress,
  ompSearchPath,
  PortTakenError,
  parseLauncherArgs,
  portIsFree,
  readRunningInstance,
  recordInstance,
  startOrAttach,
} from "./launcher";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-app-launcher-"));
  dirs.push(dir);
  return join(dir, "state", "instance.json");
}

describe("parseLauncherArgs", () => {
  test("defaults to running in the current folder and opening the browser", () => {
    expect(parseLauncherArgs([])).toEqual({
      ok: true,
      args: {
        command: "run",
        folder: undefined,
        port: undefined,
        open: true,
        lines: undefined,
        ompArgs: [],
      },
    });
  });

  test("reads a folder, a port in both spellings, and --no-open", () => {
    expect(parseLauncherArgs(["/work/app", "--port", "4400", "--no-open"])).toEqual({
      ok: true,
      args: {
        command: "run",
        folder: "/work/app",
        port: 4400,
        open: false,
        lines: undefined,
        ompArgs: [],
      },
    });
    expect(parseLauncherArgs(["--port=0"])).toMatchObject({ ok: true, args: { port: 0 } });
  });

  test("rejects a bad port, an unknown option and a second folder with a plain message", () => {
    expect(parseLauncherArgs(["--port", "http"])).toEqual({
      ok: false,
      message: '--port needs a number from 0 to 65535, not "http".',
    });
    expect(parseLauncherArgs(["--port", "70000"])).toMatchObject({ ok: false });
    expect(parseLauncherArgs(["--port"])).toMatchObject({ ok: false });
    expect(parseLauncherArgs(["--open"])).toEqual({ ok: false, message: "Unknown option --open." });
    expect(parseLauncherArgs(["a", "b"])).toEqual({
      ok: false,
      message: "Only one folder can be given.",
    });
  });

  test("help and version win over running", () => {
    expect(parseLauncherArgs(["--help"])).toMatchObject({ args: { command: "help" } });
    expect(parseLauncherArgs(["-v"])).toMatchObject({ args: { command: "version" } });
  });

  test("logs and debug-report are commands only as the first word, with --lines for logs", () => {
    expect(parseLauncherArgs(["logs"])).toMatchObject({ ok: true, args: { command: "logs" } });
    expect(parseLauncherArgs(["logs", "--lines", "250"])).toMatchObject({
      ok: true,
      args: { command: "logs", lines: 250 },
    });
    expect(parseLauncherArgs(["logs", "--lines=5"])).toMatchObject({ args: { lines: 5 } });
    expect(parseLauncherArgs(["debug-report"])).toMatchObject({
      ok: true,
      args: { command: "debug-report" },
    });
    // A folder that is really called logs is written ./logs, or comes after another argument.
    expect(parseLauncherArgs(["./logs"])).toMatchObject({
      args: { command: "run", folder: "./logs" },
    });
    expect(parseLauncherArgs(["--no-open", "logs"])).toMatchObject({
      args: { command: "run", folder: "logs" },
    });
    expect(parseLauncherArgs(["logs", "--lines", "many"])).toEqual({
      ok: false,
      message: '--lines needs a number above 0, not "many".',
    });
    expect(parseLauncherArgs(["logs", "--lines", "0"])).toMatchObject({ ok: false });
  });

  test("tui takes a folder and hands everything after -- to omp, which no other command takes", () => {
    expect(parseLauncherArgs(["tui"])).toMatchObject({
      ok: true,
      args: { command: "tui", folder: undefined, ompArgs: [] },
    });
    // omp's own options, flags and all, are omp's: the app reads none of them.
    expect(parseLauncherArgs(["tui", "/work/app", "--", "--resume", "abc", "--port", "1"])).toEqual(
      {
        ok: true,
        args: {
          command: "tui",
          folder: "/work/app",
          port: undefined,
          open: true,
          lines: undefined,
          ompArgs: ["--resume", "abc", "--port", "1"],
        },
      },
    );
    expect(parseLauncherArgs(["/work/app", "--", "--resume"])).toEqual({
      ok: false,
      message: "Only the tui command takes omp's options after --.",
    });
    expect(parseLauncherArgs(["tui", "--port", "4400"])).toEqual({
      ok: false,
      message: "The tui command takes a folder, then omp's own options after --.",
    });
    expect(parseLauncherArgs(["tui", "--no-open"])).toMatchObject({ ok: false });
    // A folder that is really called tui is written ./tui.
    expect(parseLauncherArgs(["./tui"])).toMatchObject({
      args: { command: "run", folder: "./tui" },
    });
  });
});

describe("the one-instance record", () => {
  const instance = { pid: 4242, url: "http://127.0.0.1:4317/#token=abc", version: "0.1.9" };

  test("finds a live instance that answers, and ignores a dead or silent one", async () => {
    const path = await tempFile();
    await recordInstance(path, instance);
    const answers = async () => true;
    expect(await readRunningInstance(path, { alive: () => true, responds: answers })).toEqual(
      instance,
    );
    expect(await readRunningInstance(path, { alive: () => false, responds: answers })).toBeNull();
    expect(
      await readRunningInstance(path, { alive: () => true, responds: async () => false }),
    ).toBeNull();
  });

  test("treats a missing or corrupt record as nothing running", async () => {
    const path = await tempFile();
    const checks = { alive: () => true, responds: async () => true };
    expect(await readRunningInstance(path, checks)).toBeNull();
    await recordInstance(path, instance);
    await writeFile(path, "{not json");
    expect(await readRunningInstance(path, checks)).toBeNull();
    await writeFile(path, JSON.stringify({ pid: "x" }));
    expect(await readRunningInstance(path, checks)).toBeNull();
  });

  test("keeps the record private because its address holds the session token", async () => {
    const path = await tempFile();
    await recordInstance(path, instance);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("clears only its own record, so a newer instance's record survives", async () => {
    const path = await tempFile();
    await recordInstance(path, instance);
    await clearInstance(path, 1);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(instance);
    await clearInstance(path, instance.pid);
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await clearInstance(path, instance.pid);
  });

  test("keeps the record under the user's state folder", () => {
    expect(instanceFile({}, "/home/u")).toBe("/home/u/.local/state/omp-app/instance.json");
    expect(instanceFile({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe(
      "/state/omp-app/instance.json",
    );
    expect(instanceFile({ XDG_STATE_HOME: "relative" }, "/home/u")).toBe(
      "/home/u/.local/state/omp-app/instance.json",
    );
  });
});

describe("launchAddress", () => {
  const link = "http://127.0.0.1:4317/#token=abc%2Bdef";

  test("is the launch link itself when there is no folder", () => {
    expect(launchAddress(link, undefined)).toBe(link);
  });

  test("adds the folder to the fragment, after the token", () => {
    expect(launchAddress(link, "/work/app")).toBe(`${link}&folder=%2Fwork%2Fapp`);
  });

  test("encodes a folder name that would end or split the fragment", () => {
    const address = launchAddress(link, "/work/my app & co/#1/100%/a=b+c");
    expect(address).toBe(
      `${link}&folder=%2Fwork%2Fmy%20app%20%26%20co%2F%231%2F100%25%2Fa%3Db%2Bc`,
    );
    const fragment = new URLSearchParams(new URL(address).hash.slice(1));
    expect(fragment.get("token")).toBe("abc+def");
    expect(fragment.get("folder")).toBe("/work/my app & co/#1/100%/a=b+c");
  });
});

describe("startOrAttach", () => {
  const winner = { pid: 4242, url: "http://127.0.0.1:4317/#token=abc", version: "1.2.3" };
  const takenPort = () =>
    Object.assign(new Error("Failed to start server. Is port 4317 in use?"), {
      code: "EADDRINUSE",
    });
  /** A clock whose sleeps only move its time forward, so the wait costs nothing; it records each sleep. */
  const fakeClock = () => {
    let time = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
    };
  };

  test("returns the server it started, without reading the record", async () => {
    let reads = 0;
    const result = await startOrAttach({
      port: 4317,
      start: async () => "server",
      readRunning: async () => {
        reads += 1;
        return winner;
      },
    });
    expect(result).toEqual({ server: "server" });
    expect(reads).toBe(0);
  });

  test("attaches to the instance that took the port while this one was starting", async () => {
    let reads = 0;
    const result = await startOrAttach({
      port: 4317,
      start: () => Promise.reject(takenPort()),
      readRunning: async () => {
        reads += 1;
        return winner;
      },
    });
    expect(result).toEqual({ running: winner });
    expect(reads).toBe(1);
  });

  test("keeps looking for the winner's record and attaches as soon as it names an instance", async () => {
    const clock = fakeClock();
    let reads = 0;
    const result = await startOrAttach({
      port: 4317,
      start: () => Promise.reject(takenPort()),
      readRunning: async () => {
        reads += 1;
        return reads === 3 ? winner : null;
      },
      clock,
    });
    expect(result).toEqual({ running: winner });
    expect(reads).toBe(3);
    expect(clock.sleeps).toEqual([ATTACH_POLL_MS, ATTACH_POLL_MS]);
  });

  test("fails with a plain sentence only after the whole wait when no instance appears", async () => {
    const clock = fakeClock();
    let reads = 0;
    const attempt = startOrAttach({
      port: 4317,
      start: () => Promise.reject(takenPort()),
      readRunning: async () => {
        reads += 1;
        return null;
      },
      clock,
    });
    await expect(attempt).rejects.toThrow(
      "port 4317 was taken while omp app was starting. Start it again.",
    );
    await expect(attempt).rejects.toBeInstanceOf(PortTakenError);
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(ATTACH_WAIT_MS);
    expect(reads).toBe(ATTACH_WAIT_MS / ATTACH_POLL_MS + 1);
  });

  test("throws any other failure to start unchanged and never reads the record", async () => {
    const failure = new Error("could not download omp");
    let reads = 0;
    const attempt = startOrAttach({
      port: 4317,
      start: () => Promise.reject(failure),
      readRunning: async () => {
        reads += 1;
        return winner;
      },
    });
    await expect(attempt).rejects.toBe(failure);
    expect(reads).toBe(0);
  });

  test("recognises the error Bun itself throws for a port that is taken", async () => {
    const port = await freePort();
    const serve = () => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    const first = serve();
    try {
      const result = await startOrAttach({
        port,
        start: async () => serve(),
        readRunning: async () => winner,
      });
      expect(result).toEqual({ running: winner });
    } finally {
      first.stop(true);
    }
  });
});

describe("ompSearchPath", () => {
  test("adds the usual bun and local folders after the current path, only when they exist", () => {
    const exists = (path: string) => path === "/home/u/.bun/bin";
    expect(ompSearchPath("/home/u", "/usr/bin:/bin", exists)).toBe(
      "/usr/bin:/bin:/home/u/.bun/bin",
    );
    expect(ompSearchPath("/home/u", undefined, exists)).toBe("/home/u/.bun/bin");
  });

  test("does not repeat a folder that is already on the path", () => {
    expect(ompSearchPath("/home/u", "/home/u/.bun/bin:/usr/bin", () => true)).toBe(
      "/home/u/.bun/bin:/usr/bin:/home/u/.local/bin",
    );
  });
});

describe("installUnhandledRejectionLogger", () => {
  // `bun test` fails any test that leaves an unhandled rejection, so the behavior is proven in a
  // child process: with the logger the child logs the error and keeps running; without it the
  // process ends, which is how one chat's bug used to take every open chat down.
  const launcherPath = join(import.meta.dir, "launcher.ts");
  async function runChild(withLogger: boolean): Promise<{ code: number; out: string }> {
    const script = `
      import { installUnhandledRejectionLogger } from ${JSON.stringify(launcherPath)};
      ${withLogger ? 'installUnhandledRejectionLogger((m) => console.log("LOGGED " + m.replaceAll("\\n", " | ")));' : ""}
      void Promise.reject(new Error("a chat's bug"));
      void Promise.reject("plain text reason");
      setTimeout(() => { console.log("STILL RUNNING"); process.exit(0); }, 100);
    `;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, out };
  }

  test("logs each unhandled rejection in full and the process carries on", async () => {
    const { code, out } = await runChild(true);
    expect(code).toBe(0);
    expect(out).toContain("STILL RUNNING");
    expect(out).toContain("the app keeps running");
    expect(out).toContain("a chat's bug");
    expect(out).toContain("plain text reason");
  });

  test("without it the same rejection ends the process (the failure it guards against)", async () => {
    const { code, out } = await runChild(false);
    expect(code).not.toBe(0);
    expect(out).not.toContain("STILL RUNNING");
  });
});

describe("portIsFree", () => {
  const probes: Server[] = [];
  const clients: Socket[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
    for (const probe of probes.splice(0)) probe.close();
  });

  // The test's own timeout (one second) is the bound: the check must resolve within a second.
  test("a client that holds its socket during the check does not hold the check", async () => {
    const port = await freePort();
    const probe = holdListeningUntilAccepted(createServer());
    probes.push(probe);
    probe.once("listening", () => {
      const client = connect(port, "127.0.0.1");
      client.on("error", () => undefined);
      clients.push(client);
    });
    expect(await portIsFree(port, probe)).toBe(true);
  }, 1000);

  test("reads a free port as free", async () => {
    expect(await portIsFree(await freePort())).toBe(true);
  });

  test("reads a port that something listens on as busy", async () => {
    const busy = createServer();
    probes.push(busy);
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", () => resolve()));
    expect(await portIsFree((busy.address() as AddressInfo).port)).toBe(false);
  });
});

/** A port nothing listens on: bind port 0, read the port the system chose, and let it go. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * The probe with its listening step held back until a client has been accepted, so that a client
 * is inside the check when the check closes the probe.
 */
function holdListeningUntilAccepted(probe: Server): Server {
  const listen = probe.listen.bind(probe);
  probe.listen = ((port: number, host: string, listening: () => void) => {
    probe.once("connection", () => listening());
    return listen(port, host);
  }) as unknown as Server["listen"];
  return probe;
}
