import { describe, expect, test } from "bun:test";
import {
  ACCESS_LIMITS,
  AccessAlias,
  type AccessRecord,
  AccessState,
  accessChallengeSigningText,
  accessRecordSigningText,
  MachineAccessFrame,
  ServerAccessFrame,
  SshPublicKey,
} from "../src/ports/A0";

const MACHINE = "am_AAAAAAAAAAAAAAAAAAAAAA";

describe("agent access to a machine (#20)", () => {
  test("an alias is only lowercase letters, digits and dashes: nothing an ssh config reads as a pattern or option", () => {
    for (const alias of ["laptop", "build-2", "a"])
      expect(AccessAlias.safeParse(alias).success).toBe(true);
    for (const alias of [
      "x *",
      "*",
      "lap?top",
      "!laptop",
      "Laptop",
      "2laptop",
      "-x",
      "lap top",
      "",
      "a".repeat(32),
    ]) {
      expect(AccessAlias.safeParse(alias).success).toBe(false);
    }
    expect(AccessAlias.safeParse("localhost").success).toBe(false);
  });

  test("the server can send no frame that turns access on, extends it or grants sudo", () => {
    const types = ServerAccessFrame.options.map((option) => option.shape.type.value).sort();
    // `ask` (#41) only tells the machine that a chat asks for access: the person allows it there, with their password.
    expect(types).toEqual(["ack", "ask", "challenge", "close", "data", "off", "open", "ping"]);
    expect(ServerAccessFrame.safeParse({ type: "state", state: { on: true } }).success).toBe(false);
    expect(
      ServerAccessFrame.safeParse({ type: "off", until: "2030-01-01T00:00:00Z" }).success,
    ).toBe(false);
    expect(
      ServerAccessFrame.safeParse({ type: "ask", threadId: "t", chat: "c", granted: true }).success,
    ).toBe(false);
  });

  test("a data frame holds at most the frame's bytes, as base64", () => {
    const full = Buffer.alloc(ACCESS_LIMITS.frameBytes, 7).toString("base64");
    const over = Buffer.alloc(ACCESS_LIMITS.frameBytes + 3, 7).toString("base64");
    expect(MachineAccessFrame.safeParse({ type: "data", stream: 1, bytes: full }).success).toBe(
      true,
    );
    expect(MachineAccessFrame.safeParse({ type: "data", stream: 1, bytes: over }).success).toBe(
      false,
    );
    expect(
      ServerAccessFrame.safeParse({ type: "data", stream: 1, bytes: "not base64!" }).success,
    ).toBe(false);
    expect(ServerAccessFrame.safeParse({ type: "data", stream: 0, bytes: "" }).success).toBe(false);
  });

  test("an on state says when it ends and how many sessions run, within the stream limit", () => {
    expect(AccessState.safeParse({ on: false }).success).toBe(true);
    const on = { on: true, until: "2026-11-16T20:00:00Z", sessions: 1, sudoUntil: null };
    expect(AccessState.safeParse(on).success).toBe(true);
    expect(AccessState.safeParse({ on: true, sessions: 1, sudoUntil: null }).success).toBe(false);
    expect(AccessState.safeParse({ ...on, sessions: ACCESS_LIMITS.streams + 1 }).success).toBe(
      false,
    );
  });

  test("a record's signed text covers every field but the signature", () => {
    const record: Omit<AccessRecord, "signature"> = {
      machineId: MACHINE,
      seq: 3,
      stream: 2,
      kind: "command",
      command: "ls -la",
      folder: "/home/user",
      startedAt: "2026-11-16T20:00:00Z",
      endedAt: "2026-11-16T20:00:01Z",
      exitCode: 0,
      sudo: false,
    };
    const base = accessRecordSigningText(record);
    const changed: Partial<Omit<AccessRecord, "signature">>[] = [
      { machineId: "am_BBBBBBBBBBBBBBBBBBBBBB" },
      { seq: 4 },
      { stream: 3 },
      { kind: "shell" },
      { command: "ls -l" },
      { folder: "/" },
      { startedAt: "2026-11-16T20:00:02Z" },
      { endedAt: null },
      { exitCode: 1 },
      { sudo: true },
    ];
    expect(changed).toHaveLength(Object.keys(record).length);
    for (const change of changed)
      expect(accessRecordSigningText({ ...record, ...change })).not.toBe(base);
  });

  test("the challenge's signed text names the server that asked", () => {
    const one = accessChallengeSigningText(MACHINE, "n".repeat(43), "https://a.example");
    expect(accessChallengeSigningText(MACHINE, "n".repeat(43), "https://b.example")).not.toBe(one);
  });

  test("a host key is an Ed25519 OpenSSH public key line without a comment", () => {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    expect(SshPublicKey.safeParse(key).success).toBe(true);
    expect(SshPublicKey.safeParse(`${key} user@host`).success).toBe(false);
    expect(SshPublicKey.safeParse("ssh-rsa AAAAB3NzaC1yc2E").success).toBe(false);
  });
});
