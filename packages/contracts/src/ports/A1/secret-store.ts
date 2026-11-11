import { z } from "zod";
import { definePort } from "../../core/envelope";

/**
 * A secret's name as a person gives it, as in AMO_JWT_SECRET: what the app lists, and the start of the placeholder a
 * chat's AI sees (omp keeps its letters and digits, upper-cased: `$$AMOJWTSECRET_…$$`).
 */
export const SecretName = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "Use letters, digits, '_', '.' and '-', starting with a letter or digit.",
  );
export type SecretName = z.infer<typeof SecretName>;

/** omp puts a secret behind a placeholder only from 8 characters on (its `MIN_OBFUSCATE_SECRET_LEN`). */
export const SECRET_MIN_LENGTH = 8;
export const SECRET_MAX_LENGTH = 16_384;

export const SecretValue = z
  .string()
  .min(SECRET_MIN_LENGTH, `omp hides secrets of ${SECRET_MIN_LENGTH} characters or more.`)
  .max(SECRET_MAX_LENGTH, `A secret can be up to ${SECRET_MAX_LENGTH} characters.`);

/** A saved secret as a page gets it: never its value. */
export const SecretInfo = z.strictObject({
  name: SecretName,
  /** What a chat's AI sees in place of the value, and writes to use it; null when omp would show this value as it is. */
  placeholder: z.string().min(1).max(200).nullable(),
  length: z.number().int().min(1),
});
export type SecretInfo = z.infer<typeof SecretInfo>;

export const SecretsList = z.strictObject({
  /** omp's Hide Secrets (`secrets.enabled`): a chat's AI sees placeholders only while it is on. */
  hidden: z.boolean(),
  /** In the order of the file: the newest last. */
  secrets: z.array(SecretInfo).max(1_000),
  /** Entries of the file the app does not list: patterns, and secrets written by hand without a name. */
  others: z.number().int().min(0),
  /** omp's file, `<agent folder>/secrets.yml`, for editing by hand. */
  path: z.string().min(1),
});
export type SecretsList = z.infer<typeof SecretsList>;

export const SecretAddArgs = z.strictObject({ name: SecretName, value: SecretValue });
export type SecretAddArgs = z.infer<typeof SecretAddArgs>;

export const SecretNameArgs = z.strictObject({ name: SecretName });
export type SecretNameArgs = z.infer<typeof SecretNameArgs>;

export const SecretRevealResult = z.strictObject({ value: z.string().min(1) });
export type SecretRevealResult = z.infer<typeof SecretRevealResult>;

export const SecretsChanged = z.strictObject({
  list: SecretsList,
  /** The names that were not in the list before this change, wherever they came from (a page, a chat, by hand). */
  added: z.array(SecretName).max(1_000),
});
export type SecretsChanged = z.infer<typeof SecretsChanged>;

/**
 * The secrets of omp's Hide Secrets, in omp's own `<agent folder>/secrets.yml`: a chat's AI sees each one as a
 * placeholder, and omp puts the value back in a command before it runs. Values reach only the page that reveals one.
 */
export const SecretStore = definePort({
  name: "A1.secretStore",
  methods: {
    list: { args: z.strictObject({}), result: SecretsList, capability: "host.config" },
    /** Saves a new secret and turns Hide Secrets on: a secret is of no use to a chat while it is off. */
    add: { args: SecretAddArgs, result: SecretInfo, capability: "host.config" },
    remove: { args: SecretNameArgs, result: z.null(), capability: "host.config" },
    reveal: { args: SecretNameArgs, result: SecretRevealResult, capability: "host.config" },
  },
  events: {
    /** The list after any change of the file or of Hide Secrets. */
    changed: { payload: SecretsChanged, capability: "host.config" },
  },
});
export type SecretStore = typeof SecretStore;
