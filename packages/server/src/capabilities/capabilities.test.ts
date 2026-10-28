import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { D8_AP6_UNAVAILABLE_REASONS, FolderPath } from "@omp-app/contracts";
import { CHAT_HOST_METHODS } from "@omp-app/contracts/chat-host";
import {
  type CapabilityProbeResult,
  HELLO_SOURCE,
  probeCapabilities,
  probeCapabilitiesPatiently,
  probeTimedOut,
} from ".";

const dataRoot = resolve(import.meta.dir, "../../../../.data");
const temporaryRoots: string[] = [];

/**
 * A stand-in chat host: it says hello with the methods of protocol 1 (less `FAKE_MISSING`), records how it was started,
 * and reads its input until it is stopped.
 */
const FAKE_HOST = `#!/usr/bin/env bun
const recordFile = Bun.env.FAKE_RECORD_FILE;
if (recordFile) {
  await Bun.write(recordFile, JSON.stringify({
    cwd: process.cwd(),
    home: Bun.env.HOME ?? "",
    agentDir: Bun.env.PI_CODING_AGENT_DIR ?? "",
    anthropicKey: Bun.env.ANTHROPIC_API_KEY ?? "",
    args: Bun.argv.slice(2),
  }));
}
if (Bun.env.FAKE_EXIT) process.exit(Number(Bun.env.FAKE_EXIT));
const missing = new Set((Bun.env.FAKE_MISSING ?? "").split(",").filter((name) => name !== ""));
const methods = ${JSON.stringify(CHAT_HOST_METHODS)}.filter((method) => !missing.has(method));
if (Bun.env.FAKE_HELLO_DELAY_MS) await Bun.sleep(Number(Bun.env.FAKE_HELLO_DELAY_MS));
if (Bun.env.FAKE_NO_HELLO !== "1") {
  console.log(JSON.stringify({
    kind: "hello",
    protocol: 1,
    ompVersion: "18.12.6",
    methods,
    session: { id: "capability-probe", file: null, cwd: process.cwd() },
  }));
}
for await (const _chunk of Bun.stdin.stream()) {
  // A chat host reads requests until it is stopped; the check sends none.
}
`;

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const path = await mkdtemp(join(dataRoot, prefix));
  temporaryRoots.push(path);
  return path;
}

async function fakeHost(): Promise<string> {
  const root = await temporaryDirectory("capability-probe-bin-");
  const path = join(root, "fake-chat-host");
  await writeFile(path, FAKE_HOST, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function runProbe(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Promise<{ readonly result: CapabilityProbeResult; readonly root: string }> {
  const root = await temporaryDirectory("capability-probe-run-");
  const binary = await fakeHost();
  const result = await probeCapabilities({
    cwd: FolderPath.parse(join(root, "app-data")),
    chatCommand: [binary],
    env: {
      ...overrides,
      HOME: join(root, "real-home"),
      PI_CODING_AGENT_DIR: join(root, "real-agent"),
      FAKE_RECORD_FILE: join(root, "probe-record.json"),
    },
    ghBinary: join(root, "missing-gh"),
  });
  return { result, root };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("probeCapabilities", () => {
  test("a command is available when the chat host's hello lists its method, and says why when it does not", async () => {
    const { result } = await runProbe({ FAKE_MISSING: "get_tree" });
    expect(result.capabilities["omp.cmd.get_tree"]).toEqual({
      state: "unavailable",
      via: "omp",
      detail: "the chat host does not answer get_tree",
    });
    expect(result.capabilities["omp.cmd.get_state"]).toEqual({ state: "available", via: "omp" });
    expect(result.capabilities["omp.ui"]).toEqual({ state: "available", via: "omp" });
    expect(result.capabilities["omp.host-tools"]).toEqual({ state: "available", via: "omp" });
    expect(result.capabilities["omp.host-uris"]).toEqual({ state: "available", via: "omp" });
    expect(result.capabilities["omp.subagent-events"]).toEqual({ state: "available", via: "omp" });
    expect(result.capabilities["omp.live-voice"]).toEqual({ state: "available", via: "omp" });
    expect(result.capabilities["upstream.mcp-reconnect"]).toEqual({
      state: "unavailable",
      via: "upstream",
      detail: "Reconnect this MCP server in the omp terminal; this app cannot reconnect it.",
    });
    for (const key of Object.keys(D8_AP6_UNAVAILABLE_REASONS) as Array<
      keyof typeof D8_AP6_UNAVAILABLE_REASONS
    >) {
      expect(result.capabilities[key]).toEqual({
        state: "unavailable",
        via: "upstream",
        detail: D8_AP6_UNAVAILABLE_REASONS[key],
      });
    }
    for (const key of [
      "host.config",
      "host.workspace-state",
      "host.attachments",
      "host.session-import",
      "host.mcp",
    ] as const) {
      expect(result.capabilities[key]).toEqual({ state: "available", via: "host" });
    }
    expect(result.capabilities["host.github-refs"]).toMatchObject({
      state: "fallback",
      via: "host",
    });
    expect(result.evidence.find((entry) => entry.command === "get_tree")).toEqual({
      command: "get_tree",
      status: "unavailable",
      reason: "the chat host does not answer get_tree",
      source: HELLO_SOURCE,
    });
    expect(result.evidence).toHaveLength(CHAT_HOST_METHODS.length);
    expect(probeTimedOut(result)).toBe(false);
  });

  test("every method the chat host's hello lists reads as available", async () => {
    const { result } = await runProbe();
    for (const command of CHAT_HOST_METHODS) {
      expect({ command, state: result.capabilities[`omp.cmd.${command}`]?.state }).toEqual({
        command,
        state: "available",
      });
    }
  });

  test("a feature reads as unavailable when the chat host lacks its method", async () => {
    const { result } = await runProbe({ FAKE_MISSING: "set_host_tools,live_stop" });
    expect(result.capabilities["omp.host-tools"]).toMatchObject({
      state: "unavailable",
      detail: "the chat host does not answer set_host_tools",
    });
    expect(result.capabilities["omp.live-voice"]).toMatchObject({ state: "unavailable" });
    expect(result.capabilities["omp.host-uris"]).toEqual({ state: "available", via: "omp" });
    expect(result.capabilities["omp.subagent-events"]).toEqual({ state: "available", via: "omp" });
  });

  test("a chat host that ends before its hello fails the check", async () => {
    await expect(runProbe({ FAKE_EXIT: "3" })).rejects.toThrow();
  });

  test("a chat host that does not say hello in time is a timeout, and every omp feature reads as unavailable", async () => {
    const root = await temporaryDirectory("capability-probe-timeout-");
    const binary = await fakeHost();
    const result = await probeCapabilities({
      cwd: FolderPath.parse(join(root, "app-data")),
      chatCommand: [binary],
      env: { FAKE_NO_HELLO: "1" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 200,
      deadlineMs: 400,
    });
    expect(result.capabilities["omp.cmd.get_state"]).toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("timed out"),
    });
    expect(result.capabilities["omp.ui"]).toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("timed out"),
    });
    expect(probeTimedOut(result)).toBe(true);
  });

  test("a slow hello that ran out of the first wait is asked again with a longer one, and is answered", async () => {
    const root = await temporaryDirectory("capability-probe-patient-");
    const binary = await fakeHost();
    const retries: number[] = [];
    const result = await probeCapabilitiesPatiently({
      cwd: FolderPath.parse(join(root, "app-data")),
      chatCommand: [binary],
      // The fake says hello after 300 ms: more than the first wait, well within the patient one.
      env: { FAKE_HELLO_DELAY_MS: "300" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 50,
      deadlineMs: 50,
      patient: { timeoutMs: 5_000, deadlineMs: 15_000 },
      onRetry: (waited) => retries.push(waited),
    });
    expect(retries).toHaveLength(1);
    expect(probeTimedOut(result)).toBe(false);
    expect(result.capabilities["omp.cmd.get_state"]).toEqual({ state: "available", via: "omp" });
  });

  test("a hello that never comes stays timed out, after one retry", async () => {
    const root = await temporaryDirectory("capability-probe-patient-fail-");
    const binary = await fakeHost();
    const retries: number[] = [];
    const result = await probeCapabilitiesPatiently({
      cwd: FolderPath.parse(join(root, "app-data")),
      chatCommand: [binary],
      env: { FAKE_NO_HELLO: "1" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 50,
      deadlineMs: 50,
      patient: { timeoutMs: 100, deadlineMs: 100 },
      onRetry: (waited) => retries.push(waited),
    });
    expect(retries).toHaveLength(1);
    expect(probeTimedOut(result)).toBe(true);
  });

  test("a check answered the first time is not asked again", async () => {
    const root = await temporaryDirectory("capability-probe-once-");
    const binary = await fakeHost();
    const retries: number[] = [];
    const result = await probeCapabilitiesPatiently({
      cwd: FolderPath.parse(join(root, "app-data")),
      chatCommand: [binary],
      env: {},
      ghBinary: join(root, "missing-gh"),
      onRetry: (waited) => retries.push(waited),
    });
    expect(retries).toEqual([]);
    expect(probeTimedOut(result)).toBe(false);
  });

  test("runs the chat host isolated, without a session, and removes its folder afterwards", async () => {
    const { root } = await runProbe();
    const appData = join(root, "app-data");
    expect(await readdir(appData)).toEqual([]);
    const record = JSON.parse(await readFile(join(root, "probe-record.json"), "utf8")) as {
      readonly cwd: string;
      readonly home: string;
      readonly agentDir: string;
      readonly args: readonly string[];
    };
    expect(record.cwd).toContain(".omp-capability-probe-");
    expect(record.home).toContain(`${record.cwd}/home`);
    expect(record.agentDir).toContain(`${record.cwd}/agent`);
    // omp's own flag: the check writes no session file.
    expect(record.args).toContain("--no-session");
  });

  test("gives the chat host a placeholder key so omp starts without a login, and keeps the user's own key", async () => {
    // omp exits with "No default model selected" in the probe's empty home unless some provider
    // key is set; a user who signs in with a subscription has no key in the environment.
    const readKey = async (overrides: Record<string, string | undefined>): Promise<string> => {
      const { root } = await runProbe(overrides);
      const record = JSON.parse(await readFile(join(root, "probe-record.json"), "utf8")) as {
        readonly anthropicKey: string;
      };
      return record.anthropicKey;
    };
    expect(await readKey({})).not.toBe("");
    expect(await readKey({ ANTHROPIC_API_KEY: "" })).not.toBe("");
    expect(await readKey({ ANTHROPIC_API_KEY: "the-users-own-key" })).toBe("the-users-own-key");
  });
});
