import type {
  ExtensionCatalogChanged as ExtensionCatalogChange,
  ExtensionSummary,
} from "@omp-app/contracts";
import { CapabilityMap, FolderPath, Revision, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResponse,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import type { ExtensionCatalog, ExtensionCatalogSnapshot } from "../../catalog/contract";
import { I2CapabilityKeys } from "../../catalog/contract";
import { createSkillsOperations } from "../../skills/operations";

const THREAD = ThreadId.parse("thread-i2-skills-operations");
const FOLDER = FolderPath.parse("/workspace/project");
const SKILL: ExtensionSummary = {
  id: "release-notes",
  name: "release-notes",
  provider: "omp-native",
  source: "skill",
  enabled: true,
  shadowed: false,
  capabilities: [],
  path: "skills/release-notes/SKILL.md",
  description: "Summarize changes for release notes.",
};

function snapshot(skills: readonly ExtensionSummary[] = [SKILL]): ExtensionCatalogSnapshot {
  return {
    revision: Revision.parse("revision-1"),
    extensions: [],
    skills,
    prompts: [],
    sources: [],
    truncated: false,
  };
}

class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  readonly options: DialogHostOpenOptions[] = [];
  readonly answers: DialogResult[];

  constructor(answers: readonly DialogResult[] = []) {
    this.answers = [...answers];
  }

  open<R extends DialogRequest>(
    request: R,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
    this.options.push(options);
    const result = this.answers.shift();
    if (result === undefined) return Promise.reject(new Error("No dialog answer was scripted."));
    return Promise.resolve(result as DialogResultFor<R>);
  }

  confirm(
    _request: Extract<DialogRequest, { kind: "confirm" }>,
    _options: DialogHostOpenOptions,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function answered(response: DialogResponse): DialogResult {
  return { outcome: "answered", response };
}

function setup(
  options: {
    readonly dialogs?: ScriptedDialogs;
    readonly skills?: readonly ExtensionSummary[];
    readonly catalogAvailable?: boolean;
    readonly onChange?: (listener: (change: ExtensionCatalogChange) => void) => void;
  } = {},
) {
  const dialogs = options.dialogs ?? new ScriptedDialogs();
  const list = vi.fn(async () => snapshot(options.skills));
  const reload = vi.fn(async () => snapshot(options.skills));
  const subscribe = vi.fn(async (listener: (change: ExtensionCatalogChange) => void) => {
    options.onChange?.(listener);
    return async () => {};
  });
  const catalog: ExtensionCatalog = { list, reload, subscribe };
  const operations = createSkillsOperations({
    threadId: THREAD,
    folder: FOLDER,
    capabilities: CapabilityMap.parse({
      [I2CapabilityKeys.extensionCatalog]:
        options.catalogAvailable === false
          ? { state: "unavailable", via: "host" }
          : { state: "available", via: "host" },
      [I2CapabilityKeys.skillsRegistry]: { state: "unavailable", via: "host" },
      [I2CapabilityKeys.authGateway]: { state: "unavailable", via: "host" },
    }),
    dialogs,
    catalog,
  });
  return { operations, dialogs, list, subscribe };
}

describe("I2 skills operations", () => {
  test("searches installed skills through structured catalog metadata and omits filesystem paths from the picker", async () => {
    const dialogs = new ScriptedDialogs([
      answered({ kind: "input", value: "release" }),
      answered({ kind: "select", value: "release-notes" }),
      { outcome: "cancelled", kind: "editor", timedOut: false },
    ]);
    const { operations, list } = setup({ dialogs });

    await operations.inspectInstalled();

    expect(list).toHaveBeenCalledWith(FOLDER, { signal: undefined });
    const picker = dialogs.requests[1];
    expect(picker).toMatchObject({ kind: "select", options: ["release-notes"] });
    expect(JSON.stringify(picker)).not.toContain("SKILL.md");
    expect(dialogs.requests[2]).toMatchObject({
      kind: "editor",
      readOnly: true,
      prefill: expect.not.stringContaining("skills/release-notes"),
    });
  });

  test("leaves skills registry mutations unavailable with a terminal-only reason", async () => {
    const { operations } = setup();

    expect(() => operations.registryFallback("install")).toThrow("omp terminal");
  });

  test("says authentication gateway setup is a terminal-only operation", async () => {
    const { operations } = setup();

    expect(() => operations.authGatewayFallback()).toThrow("auth gateway");
  });

  test("subscribes to catalog changes through A1.13 and refuses a missing catalog capability", async () => {
    const listeners: Array<(change: ExtensionCatalogChange) => void> = [];
    const { operations, subscribe } = setup({
      onChange: (listener) => listeners.push(listener),
    });
    const changes: ExtensionCatalogChange[] = [];

    const unsubscribe = await operations.subscribeCatalogChanges((change) => changes.push(change));
    listeners[0]?.({ revision: Revision.parse("revision-2"), reason: "filesystem" });
    await unsubscribe();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([{ revision: "revision-2", reason: "filesystem" }]);

    const missing = setup({ catalogAvailable: false });
    await expect(missing.operations.listInstalled()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: I2CapabilityKeys.extensionCatalog },
    });
  });
});
