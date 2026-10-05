import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AppError,
  CapabilityKey,
  CapabilityMap,
  EntryId,
  FolderPath,
  OMP_COMMAND_NAMES,
  OmpProcessId,
  OmpStreamMessageId,
  overridesFollowPrecedence,
  Provenance,
  parseJson,
  persistedMessageKey,
  provisionalMessageKey,
  SETTING_SOURCES,
  SessionEntryHead,
  SessionFilePath,
  sourcedSchema,
  ThreadId,
} from "../src";

describe("ids", () => {
  test("brands accept non-empty strings only", () => {
    expect(ThreadId.parse("01a10931-5fd4-7569-93a9-1dd83ac99d8f")).toBe(
      ThreadId.parse("01a10931-5fd4-7569-93a9-1dd83ac99d8f"),
    );
    expect(EntryId.safeParse("").success).toBe(false);
  });

  test("folder and session-file paths are absolute", () => {
    for (const path of ["/home/x/project", "/", "C:\\code\\app", "D:/code"]) {
      expect(FolderPath.safeParse(path).success).toBe(true);
    }
    for (const path of ["project", "./project", "/home/x/project/", "C:\\code\\"]) {
      expect(FolderPath.safeParse(path).success).toBe(false);
    }
    expect(SessionFilePath.safeParse("/s/2026-10-04_01a1.jsonl").success).toBe(true);
    expect(SessionFilePath.safeParse("/s/2026-10-04_01a1.json").success).toBe(false);
  });

  test("message keys separate persisted from streaming messages", () => {
    const thread = ThreadId.parse("t1");
    expect(persistedMessageKey(thread, EntryId.parse("a1b2c3d4"))).toBe("entry:t1:a1b2c3d4");
    expect(provisionalMessageKey(OmpProcessId.parse("p7"), OmpStreamMessageId.parse("msg-3"))).toBe(
      "stream:p7:msg-3",
    );
  });

  test("SessionEntryHead reads id and parent and keeps the rest", () => {
    const entry = {
      type: "message",
      id: "a1b2c3d4",
      parentId: null,
      timestamp: "2026-10-04T12:00:00.000Z",
      message: { role: "user", content: "hi", timestamp: 1 },
    };
    expect(SessionEntryHead.parse(entry)).toEqual(entry as never);
    expect(SessionEntryHead.safeParse({ ...entry, parentId: undefined }).success).toBe(false);
  });
});

describe("capabilities", () => {
  test("keys follow the namespaces", () => {
    for (const key of [
      "omp.cmd.prompt",
      "omp.ui",
      "host.session-files",
      "client.keymap",
      "upstream.plan-mode",
    ]) {
      expect(CapabilityKey.safeParse(key).success).toBe(true);
    }
    for (const key of [
      "omp.cmd.nope",
      "omp.anything",
      "host.",
      "host.Files",
      "client.a--b",
      "random",
    ]) {
      expect(CapabilityKey.safeParse(key).success).toBe(false);
    }
  });

  test("every omp command has a capability key", () => {
    for (const name of OMP_COMMAND_NAMES) {
      expect(CapabilityKey.safeParse(`omp.cmd.${name}`).success).toBe(true);
    }
  });

  test("a capability map holds statuses for valid keys", () => {
    expect(
      CapabilityMap.safeParse({
        "host.drafts": { state: "fallback", via: "host", detail: "local only" },
      }).success,
    ).toBe(true);
    expect(
      CapabilityMap.safeParse({ "host.drafts": { state: "maybe", via: "host" } }).success,
    ).toBe(false);
  });
});

describe("errors", () => {
  test("AppError accepts the listed codes only", () => {
    expect(AppError.safeParse({ code: "timeout", message: "late", retryable: true }).success).toBe(
      true,
    );
    expect(AppError.safeParse({ code: "teapot", message: "", retryable: false }).success).toBe(
      false,
    );
  });

  test("parseJson reports schema failures as invalid_args", () => {
    const parsed = parseJson(z.object({ n: z.number() }), '{"n":"one"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("invalid_args");
  });
});

describe("provenance", () => {
  test("setting sources run from env down to default", () => {
    expect([...SETTING_SOURCES]).toEqual([
      "env",
      "runtime",
      "overlay",
      "project",
      "global",
      "default",
    ]);
  });

  const validChains: Array<[string, string, string[]]> = [
    ["a project value over global and default", "project", ["global", "default"]],
    [
      "an env variable over every layer",
      "env",
      ["runtime", "overlay", "project", "global", "default"],
    ],
    ["a global value over a fallback env variable", "global", ["env", "default"]],
    ["a runtime override over project and a fallback env", "runtime", ["project", "env"]],
    ["an env variable over the default only", "env", ["default"]],
    ["a default nothing overrides", "default", []],
  ];

  test.each(validChains)("Sourced accepts %s", (_, source, overrides) => {
    const sourced = { value: true, source, overrides, provenance: { origin: "omp-config" } };
    expect(sourcedSchema(z.boolean()).safeParse(sourced).success).toBe(true);
  });

  const invalidChains: Array<[string, string, string[]]> = [
    ["a higher layer among the overridden", "global", ["project"]],
    ["lower layers out of order", "project", ["default", "global"]],
    ["the source itself", "global", ["global"]],
    ["a layer twice", "runtime", ["global", "global"]],
    ["anything below the default", "default", ["global"]],
    ["a fallback env variable above a configured layer", "runtime", ["env", "global"]],
    ["overlay over runtime", "overlay", ["runtime"]],
  ];

  test.each(invalidChains)("Sourced rejects %s", (_, source, overrides) => {
    const sourced = { value: true, source, overrides };
    expect(sourcedSchema(z.boolean()).safeParse(sourced).success).toBe(false);
  });

  test("overridesFollowPrecedence holds both of omp's orders", () => {
    expect(overridesFollowPrecedence("env", ["global"])).toBe(true);
    expect(overridesFollowPrecedence("global", ["env"])).toBe(true);
    expect(overridesFollowPrecedence("env", ["env"])).toBe(false);
  });

  test("Provenance knows its origins", () => {
    expect(Provenance.safeParse({ origin: "fixture", entryId: "a1b2c3d4" }).success).toBe(true);
    expect(Provenance.safeParse({ origin: "guess" }).success).toBe(false);
  });
});
