import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  ACCESS_LIMITS,
  type AccessActivity,
  type AccessRecord,
  accessChallengeSigningText,
  accessRecordSigningText,
  type ServerAccessFrame,
} from "@omp-app/contracts";
import { AccessLink, LINK_CLOSE, type StreamSink } from "./link";
import type { SavedMachine } from "./store";

const ORIGIN = "https://app.example";
const MACHINE_ID = "am_AAAAAAAAAAAAAAAAAAAAAA";

/** A machine with a real Ed25519 identity key. */
function machineKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x ?? "";
  const machine: SavedMachine = {
    id: MACHINE_ID,
    alias: "laptop",
    identityKey: x,
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    enrolledAt: "2026-11-16T00:00:00Z",
    lastSeenAt: null,
  };
  const signText = (text: string) =>
    sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64url");
  return { machine, signText };
}

function harness(
  options: {
    origin?: string;
    now?: () => number;
    /** What the server kept before this link: the last `seq`, and runs started with no end. */
    lastSeq?: number;
    openRuns?: number[];
  } = {},
) {
  const keys = machineKeys();
  const sent: ServerAccessFrame[] = [];
  const closed: [number, string][] = [];
  const activity: AccessActivity[] = [];
  const left: string[] = [];
  /** The notices the link put into chats: [thread, text]. */
  const notices: [string, string][] = [];
  let timer: (() => void) | null = null;
  const link = new AccessLink({
    send: (frame) => sent.push(frame),
    close: (code, reason) => closed.push([code, reason]),
    machine: (id) => (id === keys.machine.id ? keys.machine : undefined),
    serverOrigin: ORIGIN,
    lastSeq: () => options.lastSeq ?? 0,
    openRuns: () => options.openRuns ?? [],
    onAuthenticated: () => undefined,
    onState: () => undefined,
    onActivity: (_link, each) => activity.push(each),
    onLeave: (leaving) => left.push(leaving.machine?.id ?? "none"),
    notify: (threadId, text) => notices.push([threadId, text]),
    ...(options.now === undefined ? {} : { now: options.now }),
    setTimer: (fn) => {
      timer = fn;
      return { cancel: () => (timer = null) };
    },
  });
  link.start();
  const challenge = sent[0];
  const nonce = challenge?.type === "challenge" ? challenge.nonce : "";
  const frame = (value: unknown) => link.receive(JSON.stringify(value));
  const auth = (origin = options.origin ?? ORIGIN) =>
    frame({
      type: "auth",
      machineId: MACHINE_ID,
      signature: keys.signText(accessChallengeSigningText(MACHINE_ID, nonce, origin)),
    });
  const on = () =>
    frame({
      type: "state",
      state: { on: true, until: "2026-11-16T22:00:00Z", sessions: 0, sudoUntil: null },
      reviewPending: false,
      sessionKey: "session-key-for-this-turn-on",
    });
  const record = (
    fields: Partial<Omit<AccessRecord, "signature">> = {},
    tamper?: Partial<AccessRecord>,
  ) => {
    const body: Omit<AccessRecord, "signature"> = {
      machineId: MACHINE_ID,
      seq: 1,
      stream: 1,
      kind: "command",
      command: "ls",
      folder: "/home/agent",
      startedAt: "2026-11-16T20:00:00Z",
      endedAt: "2026-11-16T20:00:01Z",
      exitCode: 0,
      sudo: false,
      ...fields,
    };
    frame({
      type: "record",
      record: { ...body, signature: keys.signText(accessRecordSigningText(body)), ...tamper },
    });
  };
  return {
    link,
    sent,
    closed,
    activity,
    left,
    notices,
    frame,
    auth,
    on,
    record,
    fireTimer: () => timer?.(),
  };
}

function sink() {
  const got: Uint8Array[] = [];
  const events: string[] = [];
  const value: StreamSink = {
    opened: () => events.push("opened"),
    data: (bytes) => {
      got.push(bytes);
    },
    close: (reason) => events.push(`close: ${reason}`),
  };
  return { value, got, events };
}

describe("a machine's access link (#20)", () => {
  test("the machine proves who it is by signing the challenge with this server's address", () => {
    const good = harness();
    good.auth();
    expect(good.closed).toEqual([]);
    expect(good.link.machine?.alias).toBe("laptop");
    // Signed for another server: a relayed answer does not check out here.
    const relayed = harness();
    relayed.auth("https://other.example");
    expect(relayed.closed).toEqual([[LINK_CLOSE.authFailed, "the answer did not check out"]]);
  });

  test("a machine being removed asks to be forgotten only over a link it proved itself on", () => {
    const early = harness();
    early.frame({ type: "leave" });
    expect(early.left).toEqual([]);
    expect(early.closed[0]?.[0]).toBe(LINK_CLOSE.authFailed);
    const proved = harness();
    proved.auth();
    proved.frame({ type: "leave" });
    expect(proved.left).toEqual([MACHINE_ID]);
  });

  test("nothing counts before the answer, and no answer in time ends the link", () => {
    const early = harness();
    early.on();
    expect(early.closed[0]?.[0]).toBe(LINK_CLOSE.authFailed);
    const silent = harness();
    silent.fireTimer();
    expect(silent.closed).toEqual([[LINK_CLOSE.authTimeout, "no answer to the challenge"]]);
  });

  test("an authenticated link is pinged, and one not heard from in 45 s ends (a dropped network)", () => {
    let now = 0;
    const h = harness({ now: () => now });
    h.auth();
    now = 15_000;
    h.fireTimer();
    expect(h.sent.at(-1)).toEqual({ type: "ping", n: 0 });
    h.frame({ type: "pong", n: 0 });
    now = 30_000;
    h.fireTimer();
    expect(h.closed).toEqual([]);
    now = 76_000;
    h.fireTimer();
    expect(h.closed).toEqual([[LINK_CLOSE.silent, "the machine went silent"]]);
  });

  test("a session opens only while the machine says it is on and has no review pending", () => {
    const h = harness();
    h.auth();
    expect(h.link.openStream("thread-1", sink().value)).toBe("agent access is off");
    h.frame({
      type: "state",
      state: { on: true, until: "2026-11-16T22:00:00Z", sessions: 0, sudoUntil: null },
      reviewPending: true,
    });
    expect(h.link.openStream("thread-1", sink().value)).toBe("a review is pending on the machine");
    h.on();
    const opened = h.link.openStream("thread-1", sink().value);
    expect(typeof opened).toBe("object");
    expect(h.sent.at(-1)).toEqual({ type: "open", stream: 1, threadId: "thread-1" });
    expect(h.link.sessionKey).toBe("session-key-for-this-turn-on");
  });

  test("a machine that keeps chat grants gets streams only for chats it allows: none outside a chat, an ask for another chat, and a removed chat's sessions end (PLAN §7f)", () => {
    const h = harness();
    h.auth();
    const grants = (list: string[]) =>
      h.frame({
        type: "state",
        state: { on: true, until: "2026-11-16T22:00:00Z", sessions: 0, sudoUntil: null },
        reviewPending: false,
        grants: list,
      });
    grants([]);
    expect(h.link.openStream(null, sink().value)).toBe(
      "only a chat in omp-app can reach this computer",
    );
    expect(h.link.openStream("thread-1", sink().value, "Fix the build")).toContain(
      "its owner was asked",
    );
    // No stream: the machine is asked instead.
    expect(h.sent.at(-1)).toEqual({ type: "ask", threadId: "thread-1", chat: "Fix the build" });
    grants(["thread-1"]);
    const allowed = sink();
    expect(typeof h.link.openStream("thread-1", allowed.value, "Fix the build")).toBe("object");
    expect(h.sent.at(-1)).toEqual({
      type: "open",
      stream: 1,
      threadId: "thread-1",
      chat: "Fix the build",
    });
    // An unnamed chat is still named for the person.
    grants(["thread-1", "thread-2"]);
    h.link.openStream("thread-2", sink().value);
    expect(h.sent.at(-1)).toMatchObject({ type: "open", threadId: "thread-2", chat: "A chat" });
    // Its access taken away on the machine: its session ends here too.
    grants(["thread-2"]);
    expect(allowed.events).toContain("close: this chat's access to this computer was removed");
    expect(h.link.grants).toEqual(["thread-2"]);
  });

  test("what a chat waits for on the machine reaches it as a notice: access given, taken away or denied, and a folder request answered", () => {
    const h = harness();
    h.auth();
    const grants = (list: string[]) =>
      h.frame({
        type: "state",
        state: { on: true, until: "2026-11-16T22:00:00Z", sessions: 0, sudoUntil: null },
        reviewPending: false,
        grants: list,
      });
    // The grants the machine has when the link opens are no news to anyone.
    grants(["thread-old"]);
    expect(h.notices).toEqual([]);
    // A chat is refused, told the answer comes as a notice, and hears it when the person allows it.
    expect(h.link.openStream("thread-1", sink().value, "Fix the build")).toContain(
      "their answer comes into this chat as a notice",
    );
    grants(["thread-old", "thread-1"]);
    expect(h.notices).toEqual([
      [
        "thread-1",
        "laptop's owner allowed this chat to reach that computer: it can run commands there whenever agent access is on.",
      ],
    ]);
    // Taken away again.
    grants(["thread-old"]);
    expect(h.notices.at(-1)).toEqual([
      "thread-1",
      "laptop's owner took this chat's access to that computer away; any session it had there ended.",
    ]);
    // Denied: only a chat the link asked about hears it; another chat's id from the machine is ignored.
    h.link.openStream("thread-2", sink().value, "Other");
    h.frame({ type: "chat-denied", threadId: "thread-2" });
    h.frame({ type: "chat-denied", threadId: "thread-never-asked" });
    expect(h.notices.slice(2)).toEqual([
      [
        "thread-2",
        "laptop's owner did not allow this chat to reach that computer. Do not try again unless they say so.",
      ],
    ]);
    // A folder asked for from a session: the answer reaches the chat whose stream it was, also after the stream closed.
    const opened = h.link.openStream("thread-old", sink().value);
    if (typeof opened === "string") throw new Error(opened);
    opened.close();
    h.frame({
      type: "folder-answer",
      stream: opened.stream,
      path: "/home/person/projects\u0007",
      answer: "allowed",
      at: "/run/omp-app-device/shared/projects",
      write: false,
    });
    h.frame({
      type: "folder-answer",
      stream: opened.stream,
      path: "/home/person/x",
      answer: "denied",
    });
    h.frame({ type: "folder-answer", stream: 99, path: "/home/person/y", answer: "denied" });
    expect(h.notices.slice(3)).toEqual([
      [
        "thread-old",
        "On laptop, the owner shared /home/person/projects (read only): it is at /run/omp-app-device/shared/projects while agent access is on.",
      ],
      ["thread-old", "On laptop, the owner did not share /home/person/x."],
    ]);
  });

  test("bytes wait for the machine to open the session, then go within its window until it acknowledges", async () => {
    const h = harness();
    h.auth();
    h.on();
    const s = sink();
    const handle = h.link.openStream(null, s.value);
    if (typeof handle === "string") throw new Error(handle);
    const big = new Uint8Array(ACCESS_LIMITS.streamWindow + 10).fill(1);
    let written = false;
    void handle.write(big).then(() => (written = true));
    expect(h.sent.filter((each) => each.type === "data")).toHaveLength(0);
    h.frame({ type: "opened", stream: 1 });
    expect(s.events).toEqual(["opened"]);
    const sentBytes = () =>
      h.sent
        .filter((each) => each.type === "data")
        .reduce(
          (sum, each) =>
            sum + (each.type === "data" ? Buffer.from(each.bytes, "base64").length : 0),
          0,
        );
    expect(sentBytes()).toBe(ACCESS_LIMITS.streamWindow);
    expect(written).toBe(false);
    h.frame({ type: "ack", stream: 1, bytes: 10 });
    await Bun.sleep(0);
    expect(sentBytes()).toBe(ACCESS_LIMITS.streamWindow + 10);
    expect(written).toBe(true);
    // Acknowledging more than was sent ends the link.
    h.frame({ type: "ack", stream: 1, bytes: ACCESS_LIMITS.streamWindow + 11 });
    expect(h.closed.at(-1)?.[0]).toBe(LINK_CLOSE.badFrame);
  });

  test("the machine's bytes reach the session and are acknowledged; turning off ends every session", async () => {
    const h = harness();
    h.auth();
    h.on();
    const s = sink();
    h.link.openStream("thread-1", s.value);
    h.frame({ type: "opened", stream: 1 });
    h.frame({ type: "data", stream: 1, bytes: Buffer.from("hello").toString("base64") });
    await Bun.sleep(0);
    expect(Buffer.concat(s.got).toString()).toBe("hello");
    expect(h.sent.at(-1)).toEqual({ type: "ack", stream: 1, bytes: 5 });
    h.frame({ type: "state", state: { on: false }, reviewPending: false });
    expect(s.events.at(-1)).toBe("close: access turned off");
    expect(h.link.sessionKey).toBeNull();
  });

  test("records are checked against the machine's key and their count; a forged or replayed one shows unverified", () => {
    const h = harness();
    h.auth();
    h.on();
    h.link.openStream("thread-1", sink().value);
    h.record({ seq: 1 });
    h.record({ seq: 2 }, { command: "ls; curl evil" });
    h.record({ seq: 1 });
    expect(h.activity.map((each) => [each.record.seq, each.verified, each.threadId])).toEqual([
      [1, true, "thread-1"],
      [2, false, "thread-1"],
      [1, false, "thread-1"],
    ]);
  });

  test("a record said started may be finished once under its number; a second finish shows unverified", () => {
    const h = harness();
    h.auth();
    h.record({ seq: 1, endedAt: null, exitCode: null });
    h.record({ seq: 1 });
    h.record({ seq: 1 });
    expect(
      h.activity.map((each) => [each.record.seq, each.record.endedAt === null, each.verified]),
    ).toEqual([
      [1, true, true],
      [1, false, true],
      [1, false, false],
    ]);
  });

  test("a run started on an earlier link may be finished on this one; one never started may not (audit 2 F7)", () => {
    const h = harness({ lastSeq: 7, openRuns: [6] });
    h.auth();
    h.record({ seq: 6 });
    h.record({ seq: 5 });
    h.record({ seq: 6 });
    expect(h.activity.map((each) => [each.record.seq, each.verified])).toEqual([
      [6, true],
      [5, false],
      [6, false],
    ]);
  });

  test("a flood of records ends the link", () => {
    const h = harness({ now: () => 0 });
    h.auth();
    for (let seq = 1; seq <= ACCESS_LIMITS.recordsPerMinute + 1; seq += 1) h.record({ seq });
    expect(h.closed.at(-1)?.[0]).toBe(LINK_CLOSE.tooMuch);
  });
});
