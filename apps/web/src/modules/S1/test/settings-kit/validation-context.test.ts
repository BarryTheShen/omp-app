import type { Revision } from "@omp-app/contracts";
import { expect, test } from "vitest";
import type {
  ConfigSnapshot,
  ConfigStoreClient,
  SettingControl,
  SettingsSectionDescriptor,
  SettingValidationContext,
} from "../../settings-kit";
import { commit, stage } from "../../settings-kit";

const snapshot: ConfigSnapshot = { folder: null, revision: "revision-1" as Revision, entries: [] };

test("stage exposes all pending edits and commit validates the complete staged set", async () => {
  const contexts: SettingValidationContext[] = [];
  const makeControl = (key: string): SettingControl => ({
    key,
    label: key,
    kind: "number",
    secret: false,
    apply: "live",
    validate: (_value, _snapshot, context) => {
      if (context) contexts.push(context);
      return context?.phase === "stage"
        ? { valid: true }
        : { valid: false, code: "relationship", message: "Values do not fit together." };
    },
  });
  const descriptor: SettingsSectionDescriptor = {
    id: "S1.validationContext" as SettingsSectionDescriptor["id"],
    section: "tools/GitHub" as SettingsSectionDescriptor["section"],
    title: "Validation context fixture",
    inventory: [],
    requires: [],
    controls: [makeControl("first"), makeControl("second")],
  };
  const empty: ConfigStoreClient = {
    async read() {
      throw new Error("The test uses list snapshots only.");
    },
    async list() {
      return { entries: [], revision: snapshot.revision };
    },
    async write() {
      throw new Error("Invalid cross-field values must fail before ConfigStore writes.");
    },
  };

  const first = stage(descriptor, { snapshot, edits: {} }, "first", { secret: false, value: 15 });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("First edit did not stage.");
  const second = stage(descriptor, first.state, "second", { secret: false, value: 12 });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("Second edit did not stage.");
  expect(contexts.map((context) => context.phase)).toEqual(["stage", "stage"]);
  expect(contexts[1]?.edits).toEqual({
    first: { secret: false, value: 15 },
    second: { secret: false, value: 12 },
  });

  await expect(commit(empty, descriptor, second.state, "global")).rejects.toMatchObject({
    appError: { code: "invalid_args" },
  });
  expect(contexts[2]?.phase).toBe("commit");
  expect(contexts[2]?.edits).toEqual(second.state.edits);
});
