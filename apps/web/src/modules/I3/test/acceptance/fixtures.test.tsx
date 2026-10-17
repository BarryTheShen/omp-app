import {
  type ConfigChanged,
  ConfigListResult,
  type ConfigWriteResult,
  checkScrubbed,
  FolderPath,
  MemoryEntry,
  MemoryScope,
  Rule,
  ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { OverlayHost } from "@/overlay";
import { SettingsRuntime } from "../../../S1/runtime";
import type { ConfigChangeSource, ConfigStoreClient } from "../../../S1/settings-kit";
import {
  I3_CONFIG_LIST_FIXTURE,
  I3_CONFIG_SNAPSHOTS,
  I3_SECRET_STATUS_FIXTURES,
} from "../../fixtures";
import {
  I3_MEMORY_COMMAND_RESULTS,
  I3_MEMORY_ENTRIES,
  I3_MEMORY_PAGE,
} from "../../fixtures/memory";
import { I3_RULES } from "../../fixtures/rules";
import { useMemoryCenter } from "../../memory/controller";
import type { MemoryStoreAdapter, RuleStoreAdapter } from "../../ports";
import { useRulesController } from "../../rules/controller";
import { MEMORY_SETTINGS_SECTIONS } from "../../settings/descriptors";

const folder = FolderPath.parse("/workspace/omp-project");
const threadId = ThreadId.parse("fixture-thread");

const changes: ConfigChangeSource = {
  subscribe: (_listener: (change: ConfigChanged) => void) => () => undefined,
};

afterEach(() => cleanup());

function wrapper({ children }: { readonly children: React.ReactNode }) {
  return <OverlayHost>{children}</OverlayHost>;
}

function memoryFixtureAdapter(): MemoryStoreAdapter {
  return {
    list: async () => I3_MEMORY_PAGE,
    get: async ({ id }) => ({
      parsed: true,
      rawText: "",
      entry: I3_MEMORY_ENTRIES.find((entry) => entry.id === id) ?? null,
    }),
    write: async (args) => ({
      parsed: true,
      rawText: "",
      entry: { ...I3_MEMORY_ENTRIES[0], content: args.content },
      revision: "memory-revision-2",
      previousRevision: I3_MEMORY_PAGE.revision,
    }),
    delete: async () => ({ parsed: true, rawText: "", revision: "memory-revision-2" }),
    clear: async () => ({
      parsed: true,
      rawText: "",
      revision: "memory-revision-2",
      deletedCount: 1,
    }),
    subscribeChanged: (_scope, _listener) => () => undefined,
  };
}

function ruleFixtureAdapter(): RuleStoreAdapter {
  return {
    list: async () => ({ rules: [...I3_RULES], revision: "rules-revision-1" }),
    read: async ({ id }) => {
      const rule = I3_RULES.find((candidate) => candidate.id === id);
      if (!rule) throw new Error("Rule not found.");
      return rule;
    },
    write: async (args) => ({
      rule: {
        ...I3_RULES[0],
        id: args.id,
        content: args.content,
        enabled: args.enabled,
      },
      revision: "rules-revision-2",
      previousRevision: "rules-revision-1",
    }),
    delete: async () => ({ deleted: true, revision: "rules-revision-2" }),
    subscribeChanged: (_scope, _listener) => () => undefined,
  };
}

function configClientFor(
  snapshot: (typeof I3_CONFIG_SNAPSHOTS)[number]["snapshot"],
): ConfigStoreClient {
  const entries = [...snapshot.entries];
  return {
    read: async ({ key }) => {
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`Missing setting ${key}.`);
      return entry;
    },
    list: async () => ({ entries, revision: snapshot.revision }),
    write: async (): Promise<ConfigWriteResult> => {
      throw new Error("Fixture settings are read-only.");
    },
  };
}

describe("I3.5 scrubbed fixtures through their real consumers", () => {
  test("loads the memory page and command results through the memory controller", async () => {
    const adapter = memoryFixtureAdapter();
    const { result } = renderHook(
      () =>
        useMemoryCenter({
          adapter,
          folder,
          threadId,
          open: true,
          runCommand: async (request) => {
            const command = I3_MEMORY_COMMAND_RESULTS.find(
              (candidate) => candidate.command === request.command,
            );
            if (!command) throw new Error(`Missing memory fixture for ${request.command}.`);
            return command;
          },
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.state.entries).toEqual(I3_MEMORY_ENTRIES));
    expect(result.current.state.revision).toBe(I3_MEMORY_PAGE.revision);
    await act(async () => result.current.actions.runCommand("enqueue"));
    expect(result.current.state.command).toEqual(
      I3_MEMORY_COMMAND_RESULTS.find((candidate) => candidate.command === "enqueue"),
    );
  });

  test("loads rule fixtures through the rules controller", async () => {
    const adapter = ruleFixtureAdapter();
    const { result } = renderHook(() => useRulesController({ adapter, folder, open: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.state.rules).toEqual(I3_RULES));
    await act(async () => result.current.actions.select(I3_RULES[0]?.id));
    expect(result.current.state.draft).toBe(I3_RULES[0]?.content);
    expect(result.current.state.enabled).toBe(true);
  });

  test("loads every ConfigStore section snapshot through SettingsRuntime", async () => {
    for (const fixture of I3_CONFIG_SNAPSHOTS.filter(({ source }) => source === "project")) {
      const section = MEMORY_SETTINGS_SECTIONS.find(
        (candidate) => candidate.id === fixture.sectionId,
      );
      if (!section) throw new Error(`Missing settings section ${fixture.sectionId}.`);
      const runtime = new SettingsRuntime(configClientFor(fixture.snapshot), changes, {
        descriptor: section,
        folder,
        layer: "project",
      });
      try {
        await runtime.read();
        expect(runtime.getSnapshot().config?.entries).toEqual(fixture.snapshot.entries);
      } finally {
        runtime.dispose();
      }
    }
  });

  test("lists every control of the five settings sections once, with secrets status-only", () => {
    const parsed = ConfigListResult.parse(I3_CONFIG_LIST_FIXTURE);
    const keys = parsed.entries.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    const sectionKeys = MEMORY_SETTINGS_SECTIONS.flatMap((section) =>
      section.controls.map((control) => control.key),
    );
    expect([...keys].sort()).toEqual([...sectionKeys].sort());
    for (const secret of I3_SECRET_STATUS_FIXTURES) {
      expect(secret.secret).toBe(true);
      expect(Object.hasOwn(secret, "value")).toBe(false);
    }
  });

  test("covers every memory scope the contract defines", () => {
    expect(new Set(I3_MEMORY_ENTRIES.map((entry) => entry.scope))).toEqual(
      new Set(MemoryScope.options),
    );
  });

  test("holds one set and one unset secret", () => {
    expect(I3_SECRET_STATUS_FIXTURES.map((secret) => secret.isSet)).toEqual([true, false]);
  });

  test("parses scrubbed records without private paths or credentials", () => {
    for (const entry of I3_MEMORY_ENTRIES) MemoryEntry.parse(entry);
    for (const rule of I3_RULES) Rule.parse(rule);
    expect(
      checkScrubbed(
        JSON.stringify({
          memory: I3_MEMORY_PAGE,
          commands: I3_MEMORY_COMMAND_RESULTS,
          rules: I3_RULES,
          config: I3_CONFIG_LIST_FIXTURE,
        }),
      ),
    ).toEqual([]);
  });
});
