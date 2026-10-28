import { describe, expect, test } from "bun:test";
import { checkScrubbed, PRIVATE_PATH_ROOTS } from "../src";

describe("checkScrubbed", () => {
  // Key-shaped test values are assembled at run time so the file itself holds none.
  const fake = (prefix: string, length: number) =>
    `${prefix}${"x1Y2".repeat(length).slice(0, length)}`;

  const leaks: Array<[string, string, string]> = [
    ["a Linux home path", '{"cwd":"/home/user/project"}', "path"],
    ["a macOS home path", "see /Users/alice/Library", "path"],
    ["root's home", '{"path":"/root/.omp/agent"}', "path"],
    [
      "an omp-encoded absolute path in a session bucket",
      '{"sessionFile":"<TMP>/agent/sessions/--home-alice-work-repo--/s.jsonl"}',
      "path",
    ],
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

  test("omp's home- and temp-relative bucket names carry no private root", () => {
    for (const text of [
      '{"sessionFile":"<TMP>/agent/sessions/-tmp-scenario/s.jsonl"}',
      '{"sessionFile":"<HOME>/.omp/agent/sessions/-workspace-repo/s.jsonl"}',
      "flags like --homepage-url stay clean",
    ]) {
      expect({ text, problems: checkScrubbed(text) }).toEqual({ text, problems: [] });
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
