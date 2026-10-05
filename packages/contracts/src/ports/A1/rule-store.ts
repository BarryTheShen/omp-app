import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { Revision } from "./shared";

export const RuleScope = z.enum(["global", "project"]);
export type RuleScope = z.infer<typeof RuleScope>;

/** A safe native rule filename; path separators and traversal are rejected. */
export const RuleName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|mdc)$/, "rule name must be a Markdown rule filename");
export type RuleName = z.infer<typeof RuleName>;

export const RuleSource = z.enum(["agent", "project"]);
export type RuleSource = z.infer<typeof RuleSource>;

/** Markdown body and safe metadata from one omp-native rule file. */
export const Rule = z.strictObject({
  id: RuleName,
  name: z.string().min(1).max(128),
  scope: RuleScope,
  content: z.string(),
  enabled: z.boolean(),
  source: RuleSource,
  revision: Revision,
});
export type Rule = z.infer<typeof Rule>;

export const RuleListArgs = z
  .strictObject({
    folder: FolderPath.nullable(),
    scope: RuleScope,
  })
  .refine(
    (args) => (args.scope === "global" ? args.folder === null : args.folder !== null),
    "global rules require a null folder; project rules require a folder",
  );
export type RuleListArgs = z.infer<typeof RuleListArgs>;

export const RuleListResult = z.strictObject({
  rules: z.array(Rule),
  revision: Revision,
});
export type RuleListResult = z.infer<typeof RuleListResult>;

export const RuleReadArgs = z
  .strictObject({
    folder: FolderPath.nullable(),
    scope: RuleScope,
    id: RuleName,
  })
  .refine(
    (args) => (args.scope === "global" ? args.folder === null : args.folder !== null),
    "global rules require a null folder; project rules require a folder",
  );
export type RuleReadArgs = z.infer<typeof RuleReadArgs>;

export const RuleWriteArgs = z
  .strictObject({
    folder: FolderPath.nullable(),
    scope: RuleScope,
    id: RuleName,
    content: z.string(),
    enabled: z.boolean(),
    expectedRevision: Revision.nullable(),
  })
  .refine(
    (args) => (args.scope === "global" ? args.folder === null : args.folder !== null),
    "global rules require a null folder; project rules require a folder",
  );
export type RuleWriteArgs = z.infer<typeof RuleWriteArgs>;

export const RuleWriteResult = z.strictObject({
  rule: Rule,
  revision: Revision,
  previousRevision: Revision,
});
export type RuleWriteResult = z.infer<typeof RuleWriteResult>;

export const RuleDeleteArgs = z
  .strictObject({
    folder: FolderPath.nullable(),
    scope: RuleScope,
    id: RuleName,
    expectedRevision: Revision,
  })
  .refine(
    (args) => (args.scope === "global" ? args.folder === null : args.folder !== null),
    "global rules require a null folder; project rules require a folder",
  );
export type RuleDeleteArgs = z.infer<typeof RuleDeleteArgs>;

export const RuleDeleteResult = z.strictObject({
  deleted: z.literal(true),
  revision: Revision,
});
export type RuleDeleteResult = z.infer<typeof RuleDeleteResult>;

export const RuleChanged = z.strictObject({
  folder: FolderPath.nullable(),
  scope: RuleScope,
  id: RuleName,
  revision: Revision,
  reason: z.enum(["created", "updated", "deleted", "filesystem"]),
});
export type RuleChanged = z.infer<typeof RuleChanged>;

export const RuleStore = definePort({
  name: "A1.ruleStore",
  methods: {
    list: {
      args: RuleListArgs,
      result: RuleListResult,
      capability: "host.rules",
    },
    read: {
      args: RuleReadArgs,
      result: Rule,
      capability: "host.rules",
    },
    write: {
      args: RuleWriteArgs,
      result: RuleWriteResult,
      capability: "host.rules",
    },
    delete: {
      args: RuleDeleteArgs,
      result: RuleDeleteResult,
      capability: "host.rules",
    },
  },
  events: {
    changed: {
      payload: RuleChanged,
      capability: "host.rules",
    },
  },
});
