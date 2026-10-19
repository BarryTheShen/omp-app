import { describe, expect, test } from "vitest";
import {
  HandoffRequest,
  SessionInfoMetadata,
  SessionPinRequest,
  SessionRenameRequest,
  SshHost,
  SshListResult,
  WorkspaceDirectoryRequest,
} from "../contract";

describe("D5 browser contract and secret boundary", () => {
  test("accepts typed absolute paths while rejecting relative session-file and workspace paths", () => {
    const metadata = {
      id: "thread-current",
      title: "Current conversation",
      displayTitle: "Current conversation",
      cwd: "/workspace/project",
      sessionFile: "/workspace/project/.omp/session.jsonl",
    };
    expect(SessionInfoMetadata.parse(metadata)).toEqual(metadata);
    expect(
      SessionInfoMetadata.safeParse({ ...metadata, sessionFile: "relative/session.jsonl" }).success,
    ).toBe(false);
    expect(SessionInfoMetadata.safeParse({ ...metadata, cwd: "relative/project" }).success).toBe(
      false,
    );
    expect(WorkspaceDirectoryRequest.safeParse({ path: "relative/project" }).success).toBe(false);
  });

  test("enforces request boundaries before a port receives rename, pin, or handoff values", () => {
    expect(SessionRenameRequest.parse({ title: "x".repeat(200) }).title).toHaveLength(200);
    expect(SessionRenameRequest.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(SessionRenameRequest.safeParse({ title: "   " }).success).toBe(false);
    expect(SessionRenameRequest.safeParse({ title: "Valid", extra: true }).success).toBe(false);
    expect(SessionPinRequest.safeParse({ pinned: true }).success).toBe(false);
    expect(SessionPinRequest.safeParse({ pinned: true, expectedRevision: null }).success).toBe(
      true,
    );
    expect(SessionPinRequest.safeParse({ pinned: "true", expectedRevision: null }).success).toBe(
      false,
    );
    expect(
      HandoffRequest.safeParse({ customInstructions: "Keep the summary concise." }).success,
    ).toBe(true);
    expect(HandoffRequest.safeParse({ customInstructions: "focus", raw: "untyped" }).success).toBe(
      false,
    );
  });

  test("matches SSH host identity-file shape and validates host name, address, and port bounds", () => {
    const host = {
      name: "build-server",
      host: "build.example.com",
      scope: "project",
      keyLabel: "~/.ssh/id_ed25519",
    } as const;
    expect(SshHost.parse(host)).toEqual(host);
    expect(SshHost.safeParse({ ...host, extraField: "not a declared host field" }).success).toBe(
      false,
    );
    expect(SshHost.safeParse({ ...host, name: "" }).success).toBe(false);
    expect(SshHost.safeParse({ ...host, host: "" }).success).toBe(false);
    expect(SshHost.safeParse({ ...host, port: 1 }).success).toBe(true);
    expect(SshHost.safeParse({ ...host, port: 65535 }).success).toBe(true);
    expect(SshHost.safeParse({ ...host, port: 0 }).success).toBe(false);
    expect(SshHost.safeParse({ ...host, port: 65536 }).success).toBe(false);
    expect(SshListResult.safeParse({ hosts: [host], jsonl: '{"type":"session"}' }).success).toBe(
      false,
    );
    expect(SshListResult.parse({ hosts: [host] })).toEqual({ hosts: [host] });
  });
});
