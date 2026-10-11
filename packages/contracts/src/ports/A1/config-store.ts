import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { Provenance, SettingSource } from "../../core/provenance";
import { ConfigWriteLayer, JsonValue, Revision } from "./shared";

export const ConfigKey = z
  .string()
  .min(1)
  .max(512)
  .refine((key) => !key.includes("\0"), "config keys must not contain NUL");
export type ConfigKey = z.infer<typeof ConfigKey>;

/** `app` is the app-data preference layer; all omp-owned layers remain C0 SettingSource values. */
export const ConfigSource = z.union([SettingSource, z.literal("app")]);
export type ConfigSource = z.infer<typeof ConfigSource>;

export const ConfigOverrides = z.array(SettingSource);

/** A non-secret setting. The discriminant prevents a secret payload from using `value`. */
export const ConfigValue = z.strictObject({
  key: ConfigKey,
  secret: z.literal(false),
  value: JsonValue,
  source: ConfigSource,
  overrides: ConfigOverrides,
  provenance: Provenance.optional(),
  /** The environment variable that sets this value, when the environment supplies it (omp's own name for it). */
  overriddenBy: z.string().min(1).optional(),
});
export type ConfigValue = z.infer<typeof ConfigValue>;

/** A credential/config secret is represented only by whether it is set and its effective layer. */
export const SecretStatus = z.strictObject({
  key: ConfigKey,
  secret: z.literal(true),
  isSet: z.boolean(),
  source: ConfigSource,
  overrides: ConfigOverrides,
  provenance: Provenance.optional(),
  /** The environment variable that sets this value, when the environment supplies it (omp's own name for it). */
  overriddenBy: z.string().min(1).optional(),
});
export type SecretStatus = z.infer<typeof SecretStatus>;

export const ConfigEntry = z.discriminatedUnion("secret", [ConfigValue, SecretStatus]);
export type ConfigEntry = z.infer<typeof ConfigEntry>;

export const ConfigReadArgs = z.strictObject({
  key: ConfigKey,
  /** `null` means read global/app layers without a project folder. */
  folder: FolderPath.nullable(),
});
export type ConfigReadArgs = z.infer<typeof ConfigReadArgs>;

export const ConfigListArgs = z.strictObject({
  prefix: ConfigKey.optional(),
  /** `null` means list global/app layers without a project folder. */
  folder: FolderPath.nullable(),
});
export type ConfigListArgs = z.infer<typeof ConfigListArgs>;

export const ConfigListResult = z.strictObject({
  entries: z.array(ConfigEntry),
  revision: Revision,
});
export type ConfigListResult = z.infer<typeof ConfigListResult>;

/** A value write or a write-only secret set/unset operation. Servers never log or echo the secret. */
export const ConfigWriteValue = z.union([
  z.strictObject({ secret: z.literal(false), value: JsonValue }),
  z.strictObject({ secret: z.literal(true), action: z.literal("set"), value: z.string() }),
  z.strictObject({ secret: z.literal(true), action: z.literal("unset") }),
]);
export type ConfigWriteValue = z.infer<typeof ConfigWriteValue>;

export const ConfigWriteArgs = z
  .strictObject({
    key: ConfigKey,
    layer: ConfigWriteLayer,
    value: ConfigWriteValue,
    folder: FolderPath.nullable(),
    /** `null` means the key is expected to be absent; every write is a CAS. */
    expectedRevision: Revision.nullable(),
  })
  .refine(
    (args) => (args.layer === "project" ? args.folder !== null : args.folder === null),
    "project writes require a folder; global/app writes require a null folder",
  );
export type ConfigWriteArgs = z.infer<typeof ConfigWriteArgs>;

export const ConfigWriteResult = z
  .strictObject({
    key: ConfigKey,
    layer: ConfigWriteLayer,
    folder: FolderPath.nullable(),
    revision: Revision,
    previousRevision: Revision.nullable(),
    entry: ConfigEntry,
  })
  .refine(
    (result) => (result.layer === "project" ? result.folder !== null : result.folder === null),
    "project results require a folder; global/app results require a null folder",
  );
export type ConfigWriteResult = z.infer<typeof ConfigWriteResult>;

export const ConfigChanged = z
  .strictObject({
    key: ConfigKey,
    layer: ConfigSource,
    folder: FolderPath.nullable(),
    revision: Revision,
    entry: ConfigEntry,
  })
  .refine(
    (change) => (change.layer === "project" ? change.folder !== null : change.folder === null),
    "project changes require a folder; global/app changes require a null folder",
  );
export type ConfigChanged = z.infer<typeof ConfigChanged>;

export const ConfigStore = definePort({
  name: "A1.configStore",
  methods: {
    read: {
      args: ConfigReadArgs,
      result: ConfigEntry,
      capability: "host.config",
    },
    list: {
      args: ConfigListArgs,
      result: ConfigListResult,
      capability: "host.config",
    },
    write: {
      args: ConfigWriteArgs,
      result: ConfigWriteResult,
      capability: "host.config",
    },
  },
  events: {
    changed: {
      payload: ConfigChanged,
      capability: "host.config",
    },
  },
});
