import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  OMP_FLOOR_VERSION,
  OMP_WIRE_COMMIT,
  parseFixture,
  serializeFixture,
} from "@omp-app/contracts";
import {
  assertNoInstructionContent,
  encodeLegacySessionBucket,
  FixtureRecorder,
} from "../src/fixtures";
import type { RpcDuplex, RpcSessionEvent } from "../src/session";
import { RpcSession } from "../src/session";

class ProcessDuplex implements RpcDuplex {
  readonly #child: Bun.Subprocess;
  readonly #listeners = new Set<(chunk: Uint8Array) => void>();
  readonly #closeListeners = new Set<(cause?: unknown) => void>();
  readonly #buffer: Uint8Array[] = [];
  #closed = false;

  constructor(child: Bun.Subprocess) {
    this.#child = child;
    void this.#pump();
    void this.#watchClose();
  }

  writeLine(line: string): void {
    this.#child.stdin.write(line);
    this.#child.stdin.flush();
  }

  onChunk(listener: (chunk: Uint8Array) => void): () => void {
    this.#listeners.add(listener);
    for (const chunk of this.#buffer.splice(0)) listener(chunk);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (cause?: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill();
  }

  async #pump(): Promise<void> {
    const reader = this.#child.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (this.#listeners.size === 0) this.#buffer.push(value);
      else for (const listener of [...this.#listeners]) listener(value);
    }
  }

  async #watchClose(): Promise<void> {
    const code = await this.#child.exited;
    if (this.#closed) return;
    this.#closed = true;
    const cause = code === 0 ? undefined : new Error(`omp exited with code ${code}`);
    for (const listener of [...this.#closeListeners]) listener(cause);
  }
}

const scenario = process.argv[2] ?? "ready-v2";
const root = path.resolve(import.meta.dir, "..", "..", ".data", "record", scenario);
const home = path.join(root, "home");
const agentDir = path.join(root, "agent");
const workspace = path.join(root, "workspace");
const workspaceBucket = encodeLegacySessionBucket(workspace);
const fixturePath = path.join(import.meta.dir, "..", "fixtures", `${scenario}.fixture.jsonl`);
await Bun.$`rm -rf ${root}`.quiet();
await Bun.$`mkdir -p ${home} ${agentDir} ${workspace}`.quiet();

const inventoryByScenario: Record<string, string[]> = {
  "ready-v2": ["F1.rpc-wire-schema-and-generated-clients"],
  "oversized-frame": ["F6.assistant-text"],
  "out-of-order": ["E1.bash"],
  "prompt-stream": ["F6.assistant-text", "F6.assistant-thinking-reasoning", "E1.bash"],
  abort: ["F6.aborted-assistant-turn"],
  "ui-round-trip": ["E2.set-ask-dialog", "E2.ask-tool-dialog"],
};
async function ancestorInstructionLines(cwd: string): Promise<string[]> {
  const names = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".omp/AGENTS.md",
    ".agent/AGENTS.md",
    ".agents/AGENTS.md",
  ];
  const lines: string[] = [];
  let directory = path.resolve(cwd);
  while (true) {
    for (const name of names) {
      try {
        const content = await readFile(path.join(directory, name), "utf8");
        lines.push(...content.split(/\r?\n/).filter((line) => line.trim().length >= 8));
      } catch {
        // Missing ancestor instruction files are expected.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return lines;
}
const fake = Bun.spawn({
  cmd: ["bun", path.join(import.meta.dir, "fake-openai-server.ts"), agentDir],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
const fakeReader = fake.stdout.getReader();
let ready = "";
while (!ready.includes("READY")) {
  const { value, done } = await fakeReader.read();
  if (done) throw new Error("fake provider exited before READY");
  ready += new TextDecoder().decode(value);
}

/**
 * The omp the app runs: its chat host, omp's own command line built from the omp package the app pins (#2586), so
 * fixtures record what the app really talks to. `OMP_APP_CHAT_HOST_BIN` names the compiled one (the e2e global setup
 * builds it); without it, omp's `cli.ts` from the installed package runs on this Bun.
 */
function ompCommandLine(): readonly string[] {
  const binary = process.env.OMP_APP_CHAT_HOST_BIN;
  if (binary) return [binary];
  return [
    process.execPath,
    Bun.resolveSync("@oh-my-pi/pi-coding-agent/cli", path.resolve(import.meta.dir, "../../server")),
  ];
}

const omp = Bun.spawn({
  cmd: [
    ...ompCommandLine(),
    "--mode",
    "rpc-ui",
    "--cwd",
    workspace,
    "--model",
    "fake/fake-model",
    "--approval-mode",
    "yolo",
    "--no-rules",
    "--no-skills",
    "--no-extensions",
  ],
  cwd: workspace,
  env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: "1" },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
const rawDuplex = new ProcessDuplex(omp);
const recorder = new FixtureRecorder(rawDuplex, {
  paths: [
    { value: home, placeholder: "<HOME>" },
    { value: workspace, placeholder: "<WORKSPACE>" },
    { value: root, placeholder: "<TMP>" },
    { value: workspaceBucket, placeholder: "<WORKSPACE_BUCKET>" },
    { value: path.resolve(import.meta.dir, "../../.."), placeholder: "<TMP>" },
  ],
});
const session = new RpcSession(recorder);
const events: RpcSessionEvent[] = [];
session.onEvent((event) => events.push(event));
if (scenario === "ui-round-trip") {
  session.onRequest((request) => {
    if (request.type === "extension_ui_request" && request.method === "ask") {
      void session.answerExtensionUi({
        type: "extension_ui_response",
        id: request.id,
        answers: [{ id: "db", selectedOptions: ["SQLite"] }],
      });
    }
  });
}
await session.start();

switch (scenario) {
  case "ready-v2":
    break;
  case "oversized-frame":
    await session.send({ type: "prompt", message: "make_it_big" });
    break;
  case "out-of-order":
    await Promise.all([
      session.send({ type: "bash", command: "sleep 1 && echo slow" }),
      session.send({ type: "get_state" }),
    ]);
    break;
  case "prompt-stream":
    await session.send({ type: "prompt", message: "run_bash" });
    break;
  case "abort": {
    const pending = session.send({ type: "prompt", message: "abort_slow" });
    await new Promise<void>((resolve) => {
      const off = session.onEvent((event) => {
        if (event.kind === "omp" && event.event.type === "message_update") {
          off();
          void session.send({ type: "abort" }).then(() => resolve(), resolve);
        }
      });
    });
    await pending.catch(() => undefined);
    break;
  }
  case "ui-round-trip":
    await session.send({ type: "set_ask_dialog", enabled: true });
    await session.send({ type: "prompt", message: "ask_user" });
    break;
  default:
    throw new Error(`unknown recording scenario: ${scenario}`);
}

await session.close();
recorder.close();
fake.stdin.end();
fake.kill();
const instructionLines = await ancestorInstructionLines(workspace);
assertNoInstructionContent(recorder.frames, instructionLines);
const fixture = recorder.toFixture(
  {
    format: "omp-app.fixture",
    formatVersion: 1,
    scenario,
    description: `Scripted ${scenario} scenario against omp ${OMP_FLOOR_VERSION}.`,
    recordedAt: new Date().toISOString(),
    source: "scripted",
    omp: {
      version: OMP_FLOOR_VERSION,
      commit: OMP_WIRE_COMMIT,
      protocolVersion: session.protocolVersion,
      mode: "rpc-ui",
      args: [
        "--mode",
        "rpc-ui",
        "--cwd",
        "<WORKSPACE>",
        "--model",
        "fake/fake-model",
        "--approval-mode",
        "yolo",
        "--no-rules",
        "--no-skills",
        "--no-extensions",
      ],
    },
    provider: { kind: "fake-openai" },
    capabilities: { "omp.protocol.v2": { state: "available", via: "rpc" } },
    tags: ["W1", scenario],
    inventory: inventoryByScenario[scenario] ?? [],
  },
  ["<WORKSPACE>", "<WORKSPACE_BUCKET>"],
);
const serialized = serializeFixture(fixture);
const parsed = parseFixture(serialized);
if (!parsed.ok) throw new Error(parsed.error.message);
await Bun.write(fixturePath, serialized);
console.log(
  `recorded ${scenario}: ${fixture.frames.length} frames -> ${fixturePath} (${events.length} normalized events)`,
);
