import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  AppFailure,
  type PasteFileSaveFileResult,
  type PasteFileSaveResult,
  type SessionFilePath,
} from "@omp-app/contracts";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;

interface PasteFileSaveInput {
  readonly sessionFile: SessionFilePath;
  readonly text: string;
}

interface PasteFileSaveFileInput {
  readonly sessionFile: SessionFilePath;
  readonly name: string;
  readonly text: string;
}

export interface PasteFileStoreService {
  save(input: PasteFileSaveInput): Promise<PasteFileSaveResult>;
  /** Saves an attached text file under its own name, made safe and unique (see `safeLocalFileName`). */
  saveFile(input: PasteFileSaveFileInput): Promise<PasteFileSaveFileResult>;
}

/** The longest name a saved file keeps before its `-2`, `-3`… suffix: the contract allows 120 characters in all. */
const MAX_LOCAL_NAME = 100;

/** The longest extension a saved file keeps, its dot not counted. */
const MAX_EXTENSION = 15;

/**
 * One part of a file name (the name before the extension, or the extension) with only letters, digits, dashes and
 * underscores: accents dropped, every other run of characters made one dash, no dash at either end.
 */
function cleanNamePart(part: string): string {
  return part
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A file name for the chat's `local` folder from an attached file's name: the last part of a path only, its name and
 * extension cleaned apart (see `cleanNamePart`), at most `MAX_LOCAL_NAME` characters with the extension kept. A name
 * with nothing left is `attachment`; a name that starts with a dot (`.env`) has no extension.
 */
export function safeLocalFileName(name: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? "";
  const dot = last.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < last.length - 1;
  const stem = cleanNamePart(hasExtension ? last.slice(0, dot) : last) || "attachment";
  const extension = hasExtension ? cleanNamePart(last.slice(dot + 1)).slice(0, MAX_EXTENSION) : "";
  const suffix = extension === "" ? "" : `.${extension}`;
  return `${stem.slice(0, MAX_LOCAL_NAME - suffix.length)}${suffix}`;
}

/** The name to try the `attempt`-th time: the name itself first, then `notes-2.txt`, `notes-3.txt`… */
function numberedName(name: string, attempt: number): string {
  if (attempt === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${attempt}${name.slice(dot)}` : `${name}-${attempt}`;
}

/**
 * The `local` folder of a chat, as omp's `local://` resolver maps it: the session's artifacts folder, which is its
 * session file without `.jsonl` (omp v18.9.1 `session/session-manager.ts:152-155`), plus `local`
 * (`internal-urls/local-protocol.ts:240-251`).
 */
export function localRootOf(sessionFile: SessionFilePath): string {
  return join(sessionFile.slice(0, -JSONL_SUFFIX_LENGTH), "local");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function saveFailure(error: unknown, what: string): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new AppFailure({
      code: "permission",
      message: `${what} could not be saved to the chat's folder: permission denied.`,
      retryable: false,
    });
  }
  return new AppFailure({
    code: "internal",
    message: `${what} could not be saved to the chat's folder.`,
    retryable: false,
  });
}

const PASTED_TEXT = "The pasted text";
const ATTACHED_FILE = "The attached file";

/**
 * Saves a large paste as `paste-N.md` in the chat's `local` folder, the way omp's `#attachPasteAsFile` does
 * (omp v18.9.1 `modes/controllers/input-controller.ts:2540-2557`): the counter goes up until it names a file that is
 * not there yet, and an existing file is never overwritten. The counter lives as long as this store does, as omp's
 * counter lives as long as its controller.
 */
export function createPasteFileStore(): PasteFileStoreService {
  const counters = new Map<string, number>();
  return {
    async save({ sessionFile, text }) {
      const root = localRootOf(sessionFile);
      try {
        await fs.mkdir(root, { recursive: true });
      } catch (error) {
        throw saveFailure(error, PASTED_TEXT);
      }
      let counter = counters.get(root) ?? 0;
      for (;;) {
        counter += 1;
        counters.set(root, counter);
        const name = `paste-${counter}.md`;
        try {
          await fs.writeFile(join(root, name), text, { flag: "wx" });
          return { name, reference: `local://${name}` };
        } catch (error) {
          if (errorCode(error) === "EEXIST") continue;
          throw saveFailure(error, PASTED_TEXT);
        }
      }
    },
    async saveFile({ sessionFile, name, text }) {
      const root = localRootOf(sessionFile);
      try {
        await fs.mkdir(root, { recursive: true });
      } catch (error) {
        throw saveFailure(error, ATTACHED_FILE);
      }
      const safe = safeLocalFileName(name);
      // A file already in the folder is never overwritten: the next free numbered name is taken instead.
      for (let attempt = 1; ; attempt += 1) {
        const candidate = numberedName(safe, attempt);
        try {
          await fs.writeFile(join(root, candidate), text, { flag: "wx" });
          return { name: candidate, reference: `local://${candidate}` };
        } catch (error) {
          if (errorCode(error) === "EEXIST") continue;
          throw saveFailure(error, ATTACHED_FILE);
        }
      }
    },
  };
}
