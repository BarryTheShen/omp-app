/**
 * The pages and panels that may frame the lite view, saved in Settings → App → Integrations (`A0.app` `setEmbedders`), on
 * top of `OMP_APP_FRAME_ANCESTORS`: `<app data>/embedders.json`, `{ "sources": [...] }`. Each source is one
 * `frameAncestorOf` takes. A change counts from the next load of the lite view; no restart.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { FRAME_ANCESTOR_FORMS, frameAncestorOf } from "./frame-ancestors";

/** At most this many: a list longer than any person keeps is refused. */
export const EMBEDDERS_MAX = 32;

const Saved = z.object({ sources: z.array(z.string()).max(EMBEDDERS_MAX) });

/** A source that is not one the app takes: the error names it. */
export class EmbedderRefused extends Error {}

export class EmbeddersStore {
  readonly #file: string;
  #sources: readonly string[];
  #writes: Promise<unknown> = Promise.resolve();

  private constructor(file: string, sources: readonly string[]) {
    this.#file = file;
    this.#sources = sources;
  }

  /** The saved list, or an empty one when there is none; a source the app no longer takes is dropped. */
  static async open(file: string): Promise<EmbeddersStore> {
    let sources: readonly string[] = [];
    try {
      const parsed = Saved.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.success)
        sources = parsed.data.sources.flatMap((source) => {
          const checked = frameAncestorOf(source);
          return checked === null ? [] : [checked];
        });
    } catch {
      // No file yet, or one that is not JSON: no page is named.
    }
    return new EmbeddersStore(file, [...new Set(sources)]);
  }

  list(): readonly string[] {
    return this.#sources;
  }

  /** Replaces the list; throws `EmbedderRefused` for a source the app does not take, and saves nothing then. */
  async set(sources: readonly string[]): Promise<readonly string[]> {
    if (sources.length > EMBEDDERS_MAX)
      throw new EmbedderRefused(`At most ${EMBEDDERS_MAX} pages and panels can be named.`);
    const checked = new Set<string>();
    for (const source of sources) {
      const origin = frameAncestorOf(source);
      if (origin === null)
        throw new EmbedderRefused(
          `"${source.trim()}" is not one of these: ${FRAME_ANCESTOR_FORMS}.`,
        );
      checked.add(origin);
    }
    const next = [...checked];
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ sources: next }, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.#file);
    });
    this.#writes = write.catch(() => undefined);
    await write;
    this.#sources = next;
    return next;
  }
}
