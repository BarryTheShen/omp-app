import { describe, expect, test } from "bun:test";
import {
  checkScrubbed,
  type Fixture,
  type FixtureHeader,
  INVENTORY,
  OMP_WIRE_COMMIT,
  PRIVATE_PATH_ROOTS,
  parseFixture,
  serializeFixture,
} from "../src";

const header: FixtureHeader = {
  format: "omp-app.fixture",
  formatVersion: 1,
  scenario: "prompt-and-stream",
  description: "One prompt streams text and completes.",
  recordedAt: "2026-10-04T12:00:00.000Z",
  source: "scripted",
  omp: {
    version: "18.6.1",
    commit: OMP_WIRE_COMMIT,
    protocolVersion: 2,
    mode: "rpc-ui",
    args: ["--mode", "rpc-ui", "--session-dir", "<TMP>/sessions"],
  },
  provider: { kind: "fake-openai" },
  capabilities: { "omp.protocol.v2": { state: "available", via: "rpc" } },
  placeholders: ["<TMP>", "<WORKSPACE>"],
  redactions: { key: 1, token: 0, authHeader: 0, email: 0, path: 3 },
  tags: ["streaming"],
  inventory: [INVENTORY[0]?.id ?? "F3.open-session"],
};

const fixture: Fixture = {
  header,
  frames: [
    {
      t: 0,
      dir: "stdout",
      line: '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}',
    },
    {
      t: 3,
      dir: "stdin",
      line: '{"id":"protocol-1","type":"negotiate_protocol","protocolVersion":2}',
    },
    {
      t: 3,
      dir: "stdin",
      line: '{"id":"req_1","type":"prompt","message":"Read <WORKSPACE>/README.md"}',
    },
    {
      t: 9,
      dir: "stdout",
      line: '{"type":"notice","level":"info","message":"key <REDACTED:key> used"}',
    },
    { t: 12, dir: "stdin", line: "not json: a malformed-input scenario" },
  ],
};

describe("fixture format", () => {
  test("a fixture survives serialize and parse", () => {
    const text = serializeFixture(fixture);
    expect(text.split("\n")).toHaveLength(fixture.frames.length + 2);
    expect(parseFixture(text)).toEqual({ ok: true, value: fixture });
  });

  test("a header-only fixture parses", () => {
    expect(parseFixture(serializeFixture({ header, frames: [] })).ok).toBe(true);
  });

  const badHeaders: Array<[string, Record<string, unknown>]> = [
    ["another format", { format: "omp-app.recording" }],
    ["another version", { formatVersion: 2 }],
    ["a real session as source", { source: "recorded" }],
    ["a real provider", { provider: { kind: "anthropic" } }],
    ["a short commit", { omp: { ...header.omp, commit: "2a2c6dc" } }],
    ["a malformed inventory id", { inventory: ["F3"] }],
    ["an inventory id with no row", { inventory: ["F3.not-a-row"] }],
    ["an unknown field", { notes: "extra" }],
    ["a scenario with spaces", { scenario: "prompt and stream" }],
  ];

  test.each(badHeaders)("rejects a header with %s", (_, change) => {
    const text = `${JSON.stringify({ ...header, ...change })}\n`;
    const parsed = parseFixture(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toStartWith("header:");
  });

  const badFrames: Array<[string, unknown]> = [
    ["stderr", { t: 1, dir: "stderr", line: "{}" }],
    ["negative time", { t: -1, dir: "stdout", line: "{}" }],
    ["an embedded newline", { t: 1, dir: "stdout", line: "{}\n{}" }],
    ["an extra field", { t: 1, dir: "stdout", line: "{}", note: "x" }],
  ];

  test.each(badFrames)("rejects a frame with %s", (_, frame) => {
    const text = `${JSON.stringify(header)}\n${JSON.stringify(frame)}\n`;
    const parsed = parseFixture(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toStartWith("line 2:");
  });

  test("rejects time going backwards", () => {
    const frames = [
      { t: 5, dir: "stdout", line: "{}" },
      { t: 4, dir: "stdout", line: "{}" },
    ] as const;
    expect(() => serializeFixture({ header, frames: [...frames] })).toThrow("t goes backwards");
  });

  test("rejects a placeholder the header does not declare", () => {
    const frames = [{ t: 0, dir: "stdout" as const, line: '{"path":"<HOME>/notes.md"}' }];
    expect(() => serializeFixture({ header, frames })).toThrow("<HOME> is used but not declared");
  });

  test("accepts the <EMAIL> placeholder only when the header declares it", () => {
    const frames = [{ t: 0, dir: "stdout" as const, line: '{"author":"<EMAIL>"}' }];
    expect(() => serializeFixture({ header, frames })).toThrow("<EMAIL> is used but not declared");
    const declared = { ...header, placeholders: [...header.placeholders, "<EMAIL>" as const] };
    const text = serializeFixture({ header: declared, frames });
    expect(parseFixture(text)).toEqual({ ok: true, value: { header: declared, frames } });
  });

  test("refuses to write or read unscrubbed text", () => {
    const leaked = {
      header,
      frames: [{ t: 0, dir: "stdout" as const, line: '{"cwd":"/home/user/x"}' }],
    };
    expect(() => serializeFixture(leaked)).toThrow("path not scrubbed");
    const text = `${JSON.stringify(header)}\n${JSON.stringify(leaked.frames[0])}\n`;
    expect(parseFixture(text).ok).toBe(false);
  });
});

describe("checkScrubbed", () => {
  // Key-shaped test values are assembled at run time so the file itself holds none.
  const fake = (prefix: string, length: number) =>
    `${prefix}${"x1Y2".repeat(length).slice(0, length)}`;

  const leaks: Array<[string, string, string]> = [
    ["a Linux home path", '{"cwd":"/home/user/project"}', "path"],
    ["a macOS home path", "see /Users/alice/Library", "path"],
    ["root's home", '{"path":"/root/.omp/agent"}', "path"],
    ["an Anthropic key", `key=${fake("sk-ant-api03-", 40)}`, "key"],
    ["an OpenAI key", `"${fake("sk-proj-", 40)}"`, "key"],
    ["a GitHub token", fake("ghp_", 36), "key"],
    ["an AWS key id", `AKIA${"ABCDEFGHIJKLMNOP"}`, "key"],
    ["a JWT", `${fake("eyJ", 20)}.${fake("eyJ", 20)}.${fake("", 20)}`, "key"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----", "key"],
    ["a secret JSON field", `{"apiKey":"${fake("", 12)}"}`, "key"],
    ["a JSON-escaped secret field", `{"text":"{\\"access_token\\":\\"${fake("", 12)}\\"}"}`, "key"],
    ["a bearer token", `Authorization: Bearer ${fake("", 24)}`, "token"],
    ["basic credentials", `"Authorization":"Basic ${fake("", 16)}"`, "token"],
    ["an e-mail address", '{"email":"user@example.com"}', "email"],
    [
      "a JSON-escaped e-mail address",
      '{"text":"{\\"to\\":\\"a.b+c@mail.example.org\\"}"}',
      "email",
    ],
    ["an e-mail address ending a sentence", "Write to support@example.co.uk.", "email"],
  ];

  test.each(leaks)("catches %s", (_, text, rule) => {
    expect(checkScrubbed(text).map((problem) => problem.rule)).toContain(rule as never);
  });

  test.each([...PRIVATE_PATH_ROOTS])("catches paths under %s, and the root itself", (root) => {
    for (const text of [`{"cwd":"${root}"}`, `{"cwd":"${root}/a/b.txt"}`, `cd ${root}.`]) {
      expect({ text, rules: checkScrubbed(text).map((problem) => problem.rule) }).toEqual({
        text,
        rules: ["path"],
      });
    }
  });

  const windowsPaths: Array<[string, string]> = [
    ["a JSON-escaped user folder", '{"cwd":"C:\\\\Users\\\\bob\\\\code"}'],
    ["a temp folder", "wrote C:\\tmp\\out.txt"],
    ["forward slashes on another drive", '{"cwd":"D:/work/repo"}'],
    ["a system folder", "C:\\Windows\\System32"],
  ];

  test.each(windowsPaths)("catches a Windows drive path: %s", (_, text) => {
    expect(checkScrubbed(text).map((problem) => problem.rule)).toEqual(["path"]);
  });

  const systemPaths = [
    "/usr/bin/env",
    "/bin/sh",
    "/sbin/ip",
    "/lib/x86_64-linux-gnu/libc.so.6",
    "/lib64/ld-linux-x86-64.so.2",
    "/etc/hosts",
    "/dev/null",
    "/proc/self/status",
    "/sys/class/net",
  ];

  test.each(systemPaths)("accepts the system path %s", (path) => {
    expect(checkScrubbed(`{"cmd":"${path}"}`)).toEqual([]);
  });

  const lookalikes: Array<[string, string]> = [
    ["placeholder paths", "<WORKSPACE>/tmp/build, <HOME>/.omp/agent and <TMP>/home/x"],
    ["longer root names", "/optimize, /tmpfile, /home-assistant and /mediawiki"],
    ["URL paths", "https://example.com/tmp/x and http://127.0.0.1:8080/home"],
    ["relative paths", "./tmp/x, ../home/y, src/opt/z and ~/tmp"],
    ["slash commands", '{"type":"prompt","message":"/compact"}'],
    ["a file outside the roots", "/tmp.txt"],
  ];

  test.each(lookalikes)("accepts %s", (_, text) => {
    expect(checkScrubbed(text)).toEqual([]);
  });

  const clean: Array<[string, string]> = [
    ["placeholders", '{"cwd":"<WORKSPACE>","home":"<HOME>/notes","tmp":"<TMP>/x"}'],
    [
      "a home-like folder inside a placeholder",
      "<WORKSPACE>/home/user/docs and <WORKSPACE>/root/x",
    ],
    ["redaction markers", '{"apiKey":"<REDACTED:key>"} Authorization: Bearer <REDACTED:token>'],
    ["prose", "basic functionality, the risk-assessment-framework and a task-runner"],
    ["a short password field", '{"password":"x"}'],
    ["the e-mail placeholder", '{"author":"<EMAIL>"}'],
    ["an scp-style git remote", "origin git@github.com:can1357/oh-my-pi.git (fetch)"],
    [
      "package versions",
      "zod@4.6.5, @types/bun@1.4.2 and @omp-app/contracts@workspace:packages/contracts",
    ],
  ];

  test.each(clean)("accepts %s", (_, text) => {
    expect(checkScrubbed(text)).toEqual([]);
  });

  test("reports line and column, never the matched text", () => {
    const problems = checkScrubbed(`ok\n  {"cwd":"/home/user"}`);
    expect(problems).toEqual([{ line: 2, column: 11, rule: "path" }]);
  });
});
