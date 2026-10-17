import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CapabilityMap,
  D8_AP6_UNAVAILABLE_REASONS,
  FolderPath,
  OMP_COMMAND_NAMES,
} from "@omp-app/contracts";
import {
  type CapabilityProbeResult,
  capabilitiesForProtocol,
  probeCapabilities,
  probeCapabilitiesPatiently,
  probeRanOutOfTime,
  probeTimedOutEntirely,
  RPC_UNKNOWN_COMMAND_SOURCE,
} from ".";

const dataRoot = resolve(import.meta.dir, "../../../../.data");
const temporaryRoots: string[] = [];

const FAKE_OMP = `#!/usr/bin/env bun
const recordFile = Bun.env.FAKE_RECORD_FILE;
if (recordFile) {
  await Bun.write(recordFile, JSON.stringify({
    cwd: process.cwd(),
    home: Bun.env.HOME ?? "",
    agentDir: Bun.env.PI_CODING_AGENT_DIR ?? "",
    anthropicKey: Bun.env.ANTHROPIC_API_KEY ?? "",
  }));
}
const supportsV2 = Bun.env.FAKE_SUPPORTS_V2 !== "0";
const unknownCommand = Bun.env.FAKE_UNKNOWN_COMMAND;
const slowCommand = Bun.env.FAKE_SLOW_COMMAND;
const slowMs = Number(Bun.env.FAKE_SLOW_MS ?? 0);
const ready = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: supportsV2 ? [1, 2] : [1],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
};
console.log(JSON.stringify(ready));
  if (Bun.env.FAKE_DELAY === "1") await Bun.sleep(100);
function respond(command) {
  if (command.type === "negotiate_protocol") {
    if (!supportsV2) {
      console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Unsupported RPC protocol version: 2" }));
    } else {
      console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { protocolVersion: 2 } }));
    }
    return;
  }
  if (command.type === unknownCommand) {
    console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Unknown command: " + command.type }));
    return;
  }
  if (command.type === "prompt" || command.type === "abort_and_prompt") {
    console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "message is required" }));
    return;
  }
  if (command.type === "set_slow_mode" && typeof command.enabled !== "boolean") {
    console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "set_slow_mode requires boolean enabled" }));
    return;
  }
  console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} }));
}
let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  const lines = pending.split("\\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (Bun.env.FAKE_COMMAND_LOG) require("node:fs").appendFileSync(Bun.env.FAKE_COMMAND_LOG, command.type + "\\n");
    if (Bun.env.FAKE_PAYLOAD_LOG) require("node:fs").appendFileSync(Bun.env.FAKE_PAYLOAD_LOG, JSON.stringify(command) + "\\n");
    if (command.type === slowCommand) setTimeout(() => respond(command), slowMs);
    else respond(command);
  }
}
`;

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const path = await mkdtemp(join(dataRoot, prefix));
  temporaryRoots.push(path);
  return path;
}

async function fakeOmp(): Promise<string> {
  const root = await temporaryDirectory("capability-probe-bin-");
  const path = join(root, "fake-omp");
  await writeFile(path, FAKE_OMP, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function runProbe(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Promise<{ readonly result: CapabilityProbeResult; readonly root: string }> {
  const root = await temporaryDirectory("capability-probe-run-");
  const binary = await fakeOmp();
  const recordFile = join(root, "probe-record.json");
  const realHome = join(root, "real-home");
  const realAgent = join(root, "real-agent");
  const result = await probeCapabilities({
    cwd: FolderPath.parse(join(root, "app-data")),
    ompBin: binary,
    env: {
      ...overrides,
      HOME: realHome,
      PI_CODING_AGENT_DIR: realAgent,
      FAKE_RECORD_FILE: recordFile,
      FAKE_COMMAND_LOG: join(root, "commands.log"),
      FAKE_PAYLOAD_LOG: join(root, "payloads.log"),
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
  test("probes every command the app sends, cites unknown commands, and reports host fallbacks", async () => {
    const { result } = await runProbe({ FAKE_UNKNOWN_COMMAND: "get_tree" });
    const tree = result.capabilities["omp.cmd.get_tree"];
    expect(tree).toMatchObject({ state: "unavailable", via: "rpc" });
    expect(tree?.detail).toContain(RPC_UNKNOWN_COMMAND_SOURCE);
    expect(result.capabilities["omp.cmd.get_state"]).toEqual({ state: "available", via: "rpc" });
    expect(result.capabilities["omp.protocol.v2"]).toEqual({ state: "available", via: "rpc" });
    expect(result.capabilities["omp.ui"]).toEqual({ state: "available", via: "rpc" });
    expect(result.capabilities["omp.host-tools"]).toEqual({ state: "available", via: "rpc" });
    expect(result.capabilities["omp.host-uris"]).toEqual({ state: "available", via: "rpc" });
    expect(result.capabilities["omp.subagent-events"]).toEqual({ state: "available", via: "rpc" });
    expect(result.capabilities["omp.live-voice"]).toEqual({ state: "available", via: "rpc" });
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
    expect(result.evidence.find((entry) => entry.command === "get_tree")).toMatchObject({
      status: "unavailable",
      source: expect.stringContaining("docs/rpc.md:143-152"),
    });
    expect(result.evidence).toHaveLength(OMP_COMMAND_NAMES.length);
    expect(result.protocolVersion).toBe(2);
    // A probe that answered everything did not run out of time.
    expect(probeRanOutOfTime(result)).toBe(false);
    expect(probeTimedOutEntirely(result)).toBe(false);
  });

  test("does not send the commands the app does not send yet; they report as not probed", async () => {
    const { result, root } = await runProbe();
    const sent = (await readFile(join(root, "commands.log"), "utf8"))
      .split("\n")
      .filter((line) => line !== "");
    const unprobed = [
      "get_logout_accounts",
      "logout",
      "btw",
      "btw_cancel",
      "get_btw_history",
    ] as const;
    expect(sent).toContain("get_state");
    for (const command of unprobed) {
      expect(sent).not.toContain(command);
      expect(result.evidence.find((entry) => entry.command === command)).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("not probed"),
      });
    }
    expect(result.capabilities["omp.cmd.logout"]).toMatchObject({ state: "unavailable" });
  });

  test("probes set_slow_mode with a value omp refuses: it counts as available, and no probe turns Slow mode on", async () => {
    const { result, root } = await runProbe();
    const sent = (await readFile(join(root, "commands.log"), "utf8")).split("\n");
    expect(sent).toContain("set_slow_mode");
    const payloads: unknown[] = (await readFile(join(root, "payloads.log"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    expect(payloads).toContainEqual(expect.objectContaining({ type: "set_slow_mode" }));
    expect(payloads).not.toContainEqual(
      expect.objectContaining({ type: "set_slow_mode", enabled: true }),
    );
    expect(result.evidence.find((entry) => entry.command === "set_slow_mode")).toMatchObject({
      status: "available",
    });
    expect(result.capabilities["omp.cmd.set_slow_mode"]).toEqual({
      state: "available",
      via: "rpc",
    });
  });

  test("probes abort_and_restore_queue with a bare frame, since the app sends it to cancel a run", async () => {
    const { result, root } = await runProbe();
    const sent = (await readFile(join(root, "commands.log"), "utf8"))
      .split("\n")
      .filter((line) => line !== "");
    expect(sent).toContain("abort_and_restore_queue");
    expect(result.capabilities["omp.cmd.abort_and_restore_queue"]).toMatchObject({
      state: "available",
    });
  });

  test("keeps protocol v2 unavailable for a v1-only ready frame", async () => {
    const { result } = await runProbe({ FAKE_SUPPORTS_V2: "0" });
    expect(result.protocolVersion).toBe(1);
    expect(result.capabilities["omp.protocol.v2"]).toMatchObject({
      state: "unavailable",
      via: "rpc",
    });
    const threadMap = capabilitiesForProtocol(result.capabilities, 1);
    expect(threadMap["omp.protocol.v2"]).toMatchObject({ state: "unavailable", via: "rpc" });
    expect(threadMap).toEqual(CapabilityMap.parse(threadMap));
  });

  test("returns unavailable omp capabilities when the overall probe deadline expires", async () => {
    const root = await temporaryDirectory("capability-probe-timeout-");
    const binary = await fakeOmp();
    const result = await probeCapabilities({
      cwd: FolderPath.parse(join(root, "app-data")),
      ompBin: binary,
      env: { FAKE_DELAY: "1" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 20,
      deadlineMs: 20,
    });
    expect(result.capabilities["omp.cmd.get_state"]).toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("timed out"),
    });
    expect(result.capabilities["omp.ui"]).toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("timed out"),
    });
    expect(probeRanOutOfTime(result)).toBe(true);
    expect(probeTimedOutEntirely(result)).toBe(true);
  });

  test("a slow start that ran out of the first wait is asked again with a longer one, and is answered", async () => {
    const root = await temporaryDirectory("capability-probe-patient-");
    const binary = await fakeOmp();
    const retries: number[] = [];
    const result = await probeCapabilitiesPatiently({
      cwd: FolderPath.parse(join(root, "app-data")),
      ompBin: binary,
      // The fake answers after 100 ms: more than the first wait, well within the patient one.
      env: { FAKE_DELAY: "1" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 20,
      deadlineMs: 20,
      patient: { timeoutMs: 5_000, deadlineMs: 15_000 },
      onRetry: (waited) => retries.push(waited),
    });
    expect(retries).toHaveLength(1);
    expect(probeRanOutOfTime(result)).toBe(false);
    expect(result.capabilities["omp.cmd.get_state"]).toEqual({ state: "available", via: "rpc" });
  });

  test("a probe that runs out of time even patiently stays timed out, after one retry", async () => {
    const root = await temporaryDirectory("capability-probe-patient-fail-");
    const binary = await fakeOmp();
    const retries: number[] = [];
    const result = await probeCapabilitiesPatiently({
      cwd: FolderPath.parse(join(root, "app-data")),
      ompBin: binary,
      env: { FAKE_DELAY: "1" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 20,
      deadlineMs: 20,
      patient: { timeoutMs: 30, deadlineMs: 30 },
      onRetry: (waited) => retries.push(waited),
    });
    expect(retries).toHaveLength(1);
    expect(probeTimedOutEntirely(result)).toBe(true);
  });

  test("a probe that answered everything the first time is not asked again", async () => {
    const root = await temporaryDirectory("capability-probe-once-");
    const binary = await fakeOmp();
    const retries: number[] = [];
    const result = await probeCapabilitiesPatiently({
      cwd: FolderPath.parse(join(root, "app-data")),
      ompBin: binary,
      env: {},
      ghBinary: join(root, "missing-gh"),
      onRetry: (waited) => retries.push(waited),
    });
    expect(retries).toEqual([]);
    expect(probeRanOutOfTime(result)).toBe(false);
  });

  // Real waits on purpose: the delay runs in the spawned fake omp, out of fake timers' reach.
  test("a command that outruns its own wait is a timeout, and the probe says so", async () => {
    const root = await temporaryDirectory("capability-probe-command-timeout-");
    const binary = await fakeOmp();
    const result = await probeCapabilities({
      cwd: FolderPath.parse(join(root, "app-data")),
      ompBin: binary,
      // set_model answers after 2 s, past its 1 s wait; every other command answers at once.
      env: { FAKE_SLOW_COMMAND: "set_model", FAKE_SLOW_MS: "2000" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 1_000,
      deadlineMs: 60_000,
    });
    expect(result.capabilities["omp.cmd.set_model"]).toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("timed out"),
    });
    expect(probeRanOutOfTime(result)).toBe(true);
    expect(probeTimedOutEntirely(result)).toBe(false);
  }, 20_000);

  // Real waits on purpose: the delay runs in the spawned fake omp, out of fake timers' reach.
  test("a command that outruns its wait is asked again with the patient wait, and is answered", async () => {
    const root = await temporaryDirectory("capability-probe-command-patient-");
    const binary = await fakeOmp();
    const retries: number[] = [];
    const result = await probeCapabilitiesPatiently({
      cwd: FolderPath.parse(join(root, "app-data")),
      ompBin: binary,
      // set_model answers after 2 s: past the 1 s wait, well within the patient 10 s one.
      env: { FAKE_SLOW_COMMAND: "set_model", FAKE_SLOW_MS: "2000" },
      ghBinary: join(root, "missing-gh"),
      timeoutMs: 1_000,
      deadlineMs: 60_000,
      patient: { timeoutMs: 10_000, deadlineMs: 60_000 },
      onRetry: (waited) => retries.push(waited),
    });
    expect(retries).toHaveLength(1);
    expect(probeRanOutOfTime(result)).toBe(false);
    expect(result.capabilities["omp.cmd.set_model"]).toEqual({ state: "available", via: "rpc" });
  }, 20_000);

  test("keeps the probe isolated and removes its cwd after command probing", async () => {
    const { root } = await runProbe();
    const appData = join(root, "app-data");
    expect(await readdir(appData)).toEqual([]);
    const record = JSON.parse(await readFile(join(root, "probe-record.json"), "utf8")) as {
      readonly cwd: string;
      readonly home: string;
      readonly agentDir: string;
    };
    expect(record.cwd).toContain(".omp-capability-probe-");
    expect(record.home).toContain(`${record.cwd}/home`);
    expect(record.agentDir).toContain(`${record.cwd}/agent`);
  });

  test("gives omp a placeholder key so it starts without a login, and keeps the user's own key", async () => {
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
