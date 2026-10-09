import { describe, expect, test } from "bun:test";
import { matchExternalOmp } from "./external-omp";

const sessionId = "01a00000-0000-7000-8000-000000000010";
const sessionFile = "/home/user/.omp/agent/sessions/-workspace/2026-09-01_01a00000.jsonl";
const otherFile = "/home/user/.omp/agent/sessions/-workspace/2026-09-02_01a00001.jsonl";

describe("matchExternalOmp", () => {
  test("an omp that resumes this chat's file is a running writer of it", () => {
    const ps = `4101 /home/user/.bun/bin/omp --mode rpc-ui --resume ${sessionFile}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("running");
  });

  test("an omp that names this chat by its id as one argument is a running writer", () => {
    const ps = `4102 omp --session ${sessionId}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("running");
  });

  test("an omp for another chat does not count", () => {
    const ps = `4103 omp --mode rpc-ui --resume ${otherFile}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("a program that only mentions this chat's file is not an omp", () => {
    const ps = `4104 less ${sessionFile}`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("an id that only appears inside a longer word does not name the chat", () => {
    const ps = `4105 omp --session ${sessionId}9`;
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("the app's own server, which names no chat, is not a writer", () => {
    const ps = "4106 bun /home/user/workspace/projects/omp-app/packages/server/scripts/dev.ts";
    expect(matchExternalOmp(ps, sessionId, sessionFile)).toBe("none");
  });

  test("an empty process table has no writer", () => {
    expect(matchExternalOmp("", sessionId, sessionFile)).toBe("none");
  });
});
