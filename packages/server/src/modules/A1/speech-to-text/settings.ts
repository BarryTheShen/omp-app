import { join } from "node:path";
import {
  AppFailure,
  SpeechLanguage,
  SpeechServerApi,
  type SpeechSettings,
  type SpeechSettingsRead,
  type SpeechSettingsSetArgs,
} from "@omp-app/contracts";
import { z } from "zod";
import { compareAndSwapFile, hashContent, readFileSnapshot, resolveAppDataDir } from "../fs";
import type { StoredSpeechServer } from "./transcribe";

const FILE_NAME = "speech-to-text.json";

const StoredServer = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
  api: SpeechServerApi,
  model: z.string(),
  key: z.string().min(1).optional(),
});

const Saved = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  servers: z.array(StoredServer),
  language: SpeechLanguage,
  context: z.string(),
  keepDays: z.int().min(1),
});
type Saved = z.infer<typeof Saved>;

/** Off, with no server: the app ships no model, and the user names theirs. */
const DEFAULTS: Saved = {
  version: 1,
  enabled: false,
  servers: [],
  language: "auto",
  context: "",
  keepDays: 14,
};

export interface SpeechSettingsStoreOptions {
  readonly appDataDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly cwd?: string;
}

export type SpeechSettingsListener = (settings: SpeechSettingsRead) => void;

function revisionOf(hash: string | null): string {
  return hashContent(JSON.stringify({ hash }));
}

/** What the pages see: every server says whether it has a key, never the key. */
function shown(saved: Saved): SpeechSettings {
  return {
    enabled: saved.enabled,
    servers: saved.servers.map(({ key, ...server }) => ({ ...server, hasKey: key !== undefined })),
    language: saved.language,
    context: saved.context,
    keepDays: saved.keepDays,
  };
}

/**
 * Voice input's settings (`<app data>/speech-to-text.json`, V259): on or off, the transcription servers in the order
 * they are tried, the language, the words to recognise, and how long recordings are kept. A server's key is kept here
 * and sent only to that server. A change states the revision it was made on (another page's change first is a
 * retryable conflict), and reaches every page as `settingsChanged`.
 */
export class SpeechSettingsStore {
  readonly filePath: string;
  readonly #listeners = new Set<SpeechSettingsListener>();

  constructor(options: SpeechSettingsStoreOptions = {}) {
    this.filePath = join(options.appDataDir ?? resolveAppDataDir(options), FILE_NAME);
  }

  async read(): Promise<SpeechSettingsRead> {
    const { saved, hash } = await this.#load();
    return { settings: shown(saved), revision: revisionOf(hash) };
  }

  /** The servers in order, with their keys: for this server's own calls only. */
  async servers(): Promise<readonly StoredSpeechServer[]> {
    return (await this.#load()).saved.servers;
  }

  async values(): Promise<Pick<Saved, "language" | "context" | "keepDays" | "enabled">> {
    const { saved } = await this.#load();
    return {
      enabled: saved.enabled,
      language: saved.language,
      context: saved.context,
      keepDays: saved.keepDays,
    };
  }

  async set(args: SpeechSettingsSetArgs): Promise<SpeechSettingsRead> {
    const { saved, hash } = await this.#load();
    if (args.expectedRevision !== revisionOf(hash)) {
      throw new AppFailure({
        code: "conflict",
        message: "Voice input's settings changed on another page. Try again.",
        retryable: true,
      });
    }
    const ids = new Set<string>();
    for (const server of args.settings.servers) {
      if (ids.has(server.id)) {
        throw new AppFailure({
          code: "invalid_args",
          message: `Two transcription servers have the id ${server.id}.`,
          retryable: false,
        });
      }
      ids.add(server.id);
    }
    const kept = new Map(saved.servers.map((server) => [server.id, server.key]));
    const next: Saved = {
      version: 1,
      enabled: args.settings.enabled,
      servers: args.settings.servers.map(({ key, ...server }) => {
        const resolved = key === undefined ? kept.get(server.id) : (key ?? undefined);
        return resolved === undefined ? server : { ...server, key: resolved };
      }),
      language: args.settings.language,
      context: args.settings.context,
      keepDays: args.settings.keepDays,
    };
    if (JSON.stringify(next) === JSON.stringify(saved))
      return { settings: shown(saved), revision: revisionOf(hash) };
    const written = await compareAndSwapFile(
      this.filePath,
      `${JSON.stringify(next, null, 2)}\n`,
      hash,
    );
    const result = { settings: shown(next), revision: revisionOf(written.hash) };
    for (const listener of this.#listeners) {
      try {
        listener(result);
      } catch {
        // A listener that throws must not undo a change that is already saved.
      }
    }
    return result;
  }

  subscribe(listener: SpeechSettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #load(): Promise<{ readonly saved: Saved; readonly hash: string | null }> {
    const snapshot = await readFileSnapshot(this.filePath);
    if (!snapshot.exists) return { saved: DEFAULTS, hash: null };
    let raw: unknown;
    try {
      raw = JSON.parse(snapshot.content ?? "");
    } catch {
      raw = undefined;
    }
    const parsed = Saved.safeParse(raw);
    // A file this app cannot read is left as it is: a change built on the defaults would drop its servers and keys.
    if (!parsed.success) {
      throw new AppFailure({
        code: "invalid_args",
        message: `Voice input's settings could not be read (${this.filePath}).`,
        retryable: false,
      });
    }
    return { saved: parsed.data, hash: snapshot.hash };
  }
}
