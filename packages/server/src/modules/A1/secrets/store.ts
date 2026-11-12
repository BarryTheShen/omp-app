import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getSecretPlaceholderKey,
  loadSecrets,
  SecretObfuscator,
} from "@oh-my-pi/pi-coding-agent/secrets/index";
import { sanitizeSecretFriendlyName } from "@oh-my-pi/pi-coding-agent/secrets/placeholder";
import {
  AppFailure,
  SECRET_MIN_LENGTH,
  type SecretAddArgs,
  type SecretInfo,
  SecretName,
  type SecretNameArgs,
  type SecretRevealResult,
  type SecretsChanged,
  type SecretsList,
} from "@omp-app/contracts";
import { YAML } from "bun";
import { syncDirectory } from "../fs/atomic-file";
import type { FileWatchRegistry } from "../fs/file-watch-registry";
import { type FileWatcher, watchFile } from "../fs/file-watcher";

/** omp's Hide Secrets (`secrets.enabled`), read and turned on through the app's config store. */
export interface HideSecretsSetting {
  readonly isOn: () => Promise<boolean>;
  readonly turnOn: () => Promise<void>;
  /** Each change of it, from the app or from omp's own settings. */
  readonly onChange: (listener: () => void) => () => void;
}

export interface SecretStoreOptions {
  /** omp's agent folder: the file is its `secrets.yml`, the one every chat's omp reads. */
  readonly agentDir: string;
  readonly hideSecrets: HideSecretsSetting;
  /** The key omp mints placeholders with; omp's own per-install key unless a test gives one. */
  readonly placeholderKey?: () => Promise<string>;
  readonly watchRegistry?: FileWatchRegistry;
  readonly onError?: (error: unknown) => void;
}

/** A secret the app lists: a plain entry with a name it can show. */
interface NamedSecret {
  readonly name: string;
  readonly content: string;
}

/** omp drops its `$$` placeholders' separators: AMO_JWT_SECRET reads as `AMOJWTSECRET`. */
const sameToTheAi = (a: string, b: string): boolean =>
  sanitizeSecretFriendlyName(a) === sanitizeSecretFriendlyName(b);

const PLACEHOLDER = /^\$\$[A-Z0-9_]+(?::[ULCM])?\$\$$/;

/** A lock older than this was left by a command that ended mid-write. */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

const HEADER =
  "# omp's secrets (Hide Secrets): a chat's AI sees each value as a placeholder, and omp puts the value back in a\n" +
  "# command before it runs. omp app writes this file; comments here are not kept. Readable by you only.\n";

const refused = (message: string): AppFailure =>
  new AppFailure({ code: "invalid_args", message, retryable: false });

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** A plain entry with a name the app can show; anything else the file holds is passed through as it is. */
function namedOf(entry: unknown): NamedSecret | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const fields = entry as Record<string, unknown>;
  if (fields.type !== "plain" || typeof fields.content !== "string" || fields.content === "")
    return undefined;
  if (fields.mode !== undefined && fields.mode !== "obfuscate") return undefined;
  if (typeof fields.friendlyName !== "string" || !SecretName.safeParse(fields.friendlyName).success)
    return undefined;
  return { name: fields.friendlyName, content: fields.content };
}

/**
 * The secrets of omp's Hide Secrets in omp's own `<agent folder>/secrets.yml`. The app lists the named plain entries,
 * adds and removes them, and leaves every other entry (patterns, ones written by hand) as it is. Values leave this
 * class only through `reveal`.
 */
export class SecretStoreService {
  readonly path: string;
  readonly #options: SecretStoreOptions;
  readonly #listeners = new Set<(changed: SecretsChanged) => void>();
  /** Calls of this process wait for each other; other processes for the lock file. */
  #queue: Promise<unknown> = Promise.resolve();
  #watcher: FileWatcher | undefined;
  #stopSetting: (() => void) | undefined;
  /** The list the listeners last had, to tell what a change added. */
  #last: SecretsList | undefined;

  constructor(options: SecretStoreOptions) {
    this.#options = options;
    this.path = join(options.agentDir, "secrets.yml");
  }

  async list(): Promise<SecretsList> {
    const entries = await this.#read();
    const named = entries.map(namedOf);
    const secrets = named.filter((entry): entry is NamedSecret => entry !== undefined);
    const placeholders = await this.#placeholders(secrets);
    return {
      hidden: await this.#options.hideSecrets.isOn(),
      secrets: secrets.map((secret) => {
        const placeholder = placeholders.get(secret.name);
        return {
          name: secret.name,
          // Only a real placeholder leaves: anything else could be the value itself.
          placeholder:
            placeholder !== undefined && PLACEHOLDER.test(placeholder) ? placeholder : null,
          length: secret.content.length,
        };
      }),
      others: entries.length - secrets.length,
      path: this.path,
    };
  }

  /** Saves a new secret, then turns Hide Secrets on: a saved secret does nothing while it is off. */
  async add(args: SecretAddArgs): Promise<SecretInfo> {
    // A value from a command (`… | omp-app secret add NAME`) ends in a line break, and a pasted one often in a
    // space: kept, it would be hidden only where it appears with them.
    const value = args.value.trim();
    if (value.length < SECRET_MIN_LENGTH)
      throw refused(`omp hides secrets of ${SECRET_MIN_LENGTH} characters or more.`);
    await this.#locked(async () => {
      const entries = await this.#read();
      for (const secret of entries.map(namedOf)) {
        if (secret === undefined) continue;
        if (secret.name.toLowerCase() === args.name.toLowerCase())
          throw refused(
            `A secret named ${secret.name} is already saved: remove it first to replace it.`,
          );
        if (sameToTheAi(secret.name, args.name))
          throw refused(
            `${args.name} would read like ${secret.name} to the AI: pick another name.`,
          );
        if (secret.content === value)
          throw refused(`This value is already saved, as ${secret.name}.`);
      }
      await this.#write([
        ...entries,
        { type: "plain", content: value, mode: "obfuscate", friendlyName: args.name },
      ]);
      // Read as omp will read it, the file gives the value back exactly, or it is not kept.
      const back = (await this.#read()).map(namedOf).find((secret) => secret?.name === args.name);
      if (back?.content !== value) {
        await this.#write(entries);
        throw refused("This value could not be saved exactly as given, so it was not saved.");
      }
    });
    await this.#options.hideSecrets.turnOn();
    const saved = (await this.list()).secrets.find((secret) => secret.name === args.name);
    if (saved === undefined || saved.placeholder === null) {
      // omp would show this value to the AI as it is: it is taken out again rather than kept unhidden.
      await this.remove({ name: args.name }).catch(() => undefined);
      throw refused("omp cannot hide this value, so it was not saved.");
    }
    return saved;
  }

  async remove(args: SecretNameArgs): Promise<void> {
    await this.#locked(async () => {
      const entries = await this.#read();
      const kept = entries.filter((entry) => namedOf(entry)?.name !== args.name);
      if (kept.length === entries.length) throw refused(`No secret is named ${args.name}.`);
      await this.#write(kept);
    });
  }

  async reveal(args: SecretNameArgs): Promise<SecretRevealResult> {
    const found = (await this.#read()).map(namedOf).find((secret) => secret?.name === args.name);
    if (found === undefined) throw refused(`No secret is named ${args.name}.`);
    return { value: found.content };
  }

  /** Each change of the file (from the app, a command, omp or by hand) or of Hide Secrets, with the names it added. */
  subscribe(listener: (changed: SecretsChanged) => void): () => void {
    this.#listeners.add(listener);
    if (this.#watcher === undefined) this.#watch();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    this.#watcher?.dispose();
    this.#watcher = undefined;
    this.#stopSetting?.();
    this.#stopSetting = undefined;
    this.#listeners.clear();
  }

  #watch(): void {
    const onError = this.#options.onError ?? (() => undefined);
    void this.list()
      .then((list) => {
        this.#last ??= list;
      })
      .catch(onError);
    this.#watcher = watchFile(this.path, () => this.#changed(), {
      onError,
      ...(this.#options.watchRegistry === undefined
        ? {}
        : { registry: this.#options.watchRegistry }),
    });
    this.#stopSetting = this.#options.hideSecrets.onChange(() => {
      void this.#changed();
    });
  }

  async #changed(): Promise<void> {
    let list: SecretsList;
    try {
      list = await this.list();
    } catch (error) {
      this.#options.onError?.(error);
      return;
    }
    if (JSON.stringify(list) === JSON.stringify(this.#last)) return;
    // Before the first list is known, nothing counts as added: every saved secret would.
    const before =
      this.#last === undefined
        ? undefined
        : new Set(this.#last.secrets.map((secret) => secret.name));
    this.#last = list;
    const added =
      before === undefined
        ? []
        : list.secrets.map((secret) => secret.name).filter((name) => !before.has(name));
    for (const listener of [...this.#listeners]) listener({ list, added });
  }

  /** omp's placeholder of each named secret, minted as every chat's omp mints it from this file. */
  async #placeholders(secrets: readonly NamedSecret[]): Promise<Map<string, string>> {
    if (secrets.length === 0) return new Map();
    // The agent folder has no `.omp/secrets.yml` of its own, so omp loads this file alone.
    const entries = await loadSecrets(this.#options.agentDir, this.#options.agentDir);
    const key = await (this.#options.placeholderKey ?? (() => getSecretPlaceholderKey()))();
    const obfuscator = new SecretObfuscator(entries, key);
    return new Map(secrets.map((secret) => [secret.name, obfuscator.obfuscate(secret.content)]));
  }

  async #read(): Promise<unknown[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = YAML.parse(text);
    } catch {
      throw refused(`${this.path} is not YAML omp can read: fix it by hand first.`);
    }
    if (parsed === null || parsed === undefined) return [];
    if (!Array.isArray(parsed))
      throw refused(`${this.path} is not a list, as omp needs: fix it by hand first.`);
    return parsed;
  }

  /**
   * Writes the whole file at once: a new file, readable by the user only from its first byte and on disk before it is
   * renamed over the old, then the rename on disk. Not `writeFileAtomic`: the file watcher would take this process's
   * writes as its own and tell no listener, while a second store in the process must hear them.
   */
  async #write(entries: readonly unknown[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const body = entries.length === 0 ? "[]" : YAML.stringify(entries, null, 2).trimEnd();
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(`${HEADER}${body}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await syncDirectory(dirname(this.path));
  }

  /** Runs one change at a time: this process's in turn, other processes' (`omp-app secret`) by a lock file. */
  #locked<T>(change: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const release = await this.#lockFile();
      try {
        return await change();
      } finally {
        await release();
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #lockFile(): Promise<() => Promise<void>> {
    const lock = `${this.path}.lock`;
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.close();
        return () => rm(lock, { force: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > STALE_LOCK_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new AppFailure({
          code: "conflict",
          message: "The secrets file is busy with another change: try again.",
          retryable: true,
        });
      await Bun.sleep(25);
    }
  }
}
