import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccessActivity,
  accessChallengeSigningText,
  type ServerAccessFrame,
} from "@omp-app/contracts";
import { ActivityLog } from "./activity";
import { runDeviceSsh } from "./device-ssh";
import { AccessHub } from "./hub";
import type { AccessLink } from "./link";
import { listenAccessProxy } from "./proxy";
import { SshFiles } from "./ssh-files";
import { AccessStore } from "./store";

const ORIGIN = "https://app.example";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SCOPE = "de11be95-12a0-4621-92fb-7bab31384bfe";

let folder: string | null = null;
afterEach(async () => {
  if (folder !== null) await rm(folder, { recursive: true, force: true });
  folder = null;
});

/** A hub with one enrolled machine, its proxy socket listening, and a stand-in for the machine's side of the link. */
async function setUp() {
  folder = await mkdtemp(join(tmpdir(), "omp-app-access-"));
  const store = await AccessStore.open({ folder: join(folder, "data") });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const made = await store.enroll({
    alias: "laptop",
    identityKey: publicKey.export({ format: "jwk" }).x ?? "",
    hostKey: HOST_KEY,
  });
  if (made.status !== "enrolled") throw new Error(made.status);
  const files = new SshFiles(join(folder, "run"), ["/usr/bin/omp-app", "device-ssh"]);
  const heard: AccessActivity[] = [];
  const hub = await AccessHub.open({
    store,
    activity: await ActivityLog.open(join(folder, "data", "activity"), [made.machine.id]),
    files,
    serverOrigin: ORIGIN,
    threadOfScope: (scope) => (scope === SCOPE ? "thread-1" : null),
    onMachinesChanged: () => undefined,
    onActivity: (each) => heard.push(each),
  });
  const socketPath = join(folder, "run", "proxy.sock");
  const stopProxy = await listenAccessProxy(socketPath, hub);

  // The machine: answers the challenge, says it is on, and echoes every stream's bytes back.
  const toMachine: ServerAccessFrame[] = [];
  let link: AccessLink | null = null;
  const reply = (frame: unknown) => link?.receive(JSON.stringify(frame));
  link = hub.attach(
    (frame) => {
      toMachine.push(frame);
      if (frame.type === "challenge") {
        queueMicrotask(() =>
          reply({
            type: "auth",
            machineId: made.machine.id,
            signature: sign(
              null,
              Buffer.from(accessChallengeSigningText(made.machine.id, frame.nonce, ORIGIN)),
              privateKey,
            ).toString("base64url"),
          }),
        );
      }
      if (frame.type === "open")
        queueMicrotask(() => reply({ type: "opened", stream: frame.stream }));
      if (frame.type === "data") {
        queueMicrotask(() => {
          reply({
            type: "ack",
            stream: frame.stream,
            bytes: Buffer.from(frame.bytes, "base64").length,
          });
          reply({ type: "data", stream: frame.stream, bytes: frame.bytes });
          reply({ type: "close", stream: frame.stream });
        });
      }
    },
    () => undefined,
  );
  await Bun.sleep(0);
  const turnOn = () =>
    reply({
      type: "state",
      state: { on: true, until: "2026-11-16T22:00:00Z", sessions: 0, sudoUntil: null },
      reviewPending: false,
      sessionKey: "session-key-for-this-turn-on",
    });
  const turnOff = () => reply({ type: "state", state: { on: false }, reviewPending: false });
  return { hub, store, files, socketPath, toMachine, turnOn, turnOff, stopProxy, heard, reply };
}

/** Runs the ProxyCommand as ssh would: `input` on its stdin; what it printed, and its exit code. */
async function deviceSsh(alias: string, socketPath: string, input: string) {
  const out: Uint8Array[] = [];
  const err: string[] = [];
  const code = await runDeviceSsh({
    alias,
    socketPath,
    stdin: new Response(input).body ?? new ReadableStream(),
    stdout: (bytes) => {
      out.push(bytes.slice());
    },
    stderr: (text) => err.push(text),
    cgroup: `0::/user.slice/user@1000.service/app.slice/omp-app-chat-${SCOPE}.scope\n`,
  });
  return { code, out: Buffer.concat(out).toString(), err: err.join("") };
}

describe("an agent's ssh through the app to a machine (#20)", () => {
  test("a machine being removed is forgotten when it asks over its link, as the panel's Remove does", async () => {
    const h = await setUp();
    try {
      expect(h.store.list().map((each) => each.alias)).toEqual(["laptop"]);
      h.reply({ type: "leave" });
      await Bun.sleep(20);
      expect(h.store.list()).toEqual([]);
    } finally {
      h.stopProxy();
    }
  });

  test("refused at once, with the reason, while the machine is off or unknown", async () => {
    const h = await setUp();
    expect(await deviceSsh("laptop", h.socketPath, "x")).toEqual({
      code: 255,
      out: "",
      err: "laptop: agent access is off\n",
    });
    expect((await deviceSsh("nobody", h.socketPath, "x")).err).toBe(
      "nobody: no machine has that name\n",
    );
    h.stopProxy();
  });

  test("while on, ssh's bytes reach the machine on a stream tagged with the chat, and its answer comes back", async () => {
    const h = await setUp();
    h.turnOn();
    const result = await deviceSsh("laptop", h.socketPath, "SSH-2.0-test\r\n");
    expect(result).toEqual({ code: 0, out: "SSH-2.0-test\r\n", err: "" });
    expect(h.toMachine.find((frame) => frame.type === "open")).toEqual({
      type: "open",
      stream: 1,
      threadId: "thread-1",
    });
    h.stopProxy();
  });

  test("the ssh files pin the machine's host key under its alias, and its session key exists only while on", async () => {
    const h = await setUp();
    const config = await readFile(h.files.configPath, "utf8");
    expect(config).toContain("Host laptop\n");
    expect(config).toContain('ProxyCommand "/usr/bin/omp-app" "device-ssh" %n');
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(await readFile(join(h.files.folder, "known_hosts"), "utf8")).toBe(
      `omp-access-laptop ${HOST_KEY}\n`,
    );
    expect(existsSync(h.files.keyPath("laptop"))).toBe(false);
    h.turnOn();
    await Bun.sleep(20);
    expect(await readFile(h.files.keyPath("laptop"), "utf8")).toBe(
      "session-key-for-this-turn-on\n",
    );
    h.turnOff();
    await Bun.sleep(20);
    expect(existsSync(h.files.keyPath("laptop"))).toBe(false);
    h.stopProxy();
  });
});
