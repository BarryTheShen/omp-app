import { promises as fs } from "node:fs";
import { join } from "node:path";
import { AppFailure, type PasteFileSaveResult, type SessionFilePath } from "@omp-app/contracts";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;

interface PasteFileSaveInput {
  readonly sessionFile: SessionFilePath;
  readonly text: string;
}

export interface PasteFileStoreService {
  save(input: PasteFileSaveInput): Promise<PasteFileSaveResult>;
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

function saveFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new AppFailure({
      code: "permission",
      message: "The pasted text could not be saved to the chat's folder: permission denied.",
      retryable: false,
    });
  }
  return new AppFailure({
    code: "internal",
    message: "The pasted text could not be saved to the chat's folder.",
    retryable: false,
  });
}

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
        throw saveFailure(error);
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
          throw saveFailure(error);
        }
      }
    },
  };
}
