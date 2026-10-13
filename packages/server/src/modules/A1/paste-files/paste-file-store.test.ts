import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppFailure, SessionFilePath } from "@omp-app/contracts";
import { createPasteFileStore, localRootOf } from "./paste-file-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paste-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sessionFileIn(dir: string): SessionFilePath {
  return SessionFilePath.parse(join(dir, "sessions", "2026-10-12T00-00-00-000Z_chat-1.jsonl"));
}

describe("paste file store", () => {
  test("saves the full text as paste-1.md in the chat's local folder, beside its session file", async () => {
    const sessionFile = sessionFileIn(root);
    const saved = await createPasteFileStore().save({
      sessionFile,
      text: "line one\nline two",
    });
    expect(saved).toEqual({ name: "paste-1.md", reference: "local://paste-1.md" });
    const artifacts = sessionFile.slice(0, -".jsonl".length);
    expect(await readFile(join(artifacts, "local", "paste-1.md"), "utf8")).toBe(
      "line one\nline two",
    );
  });

  test("counts up from the last name and never overwrites a file already in the folder", async () => {
    const sessionFile = sessionFileIn(root);
    const folder = localRootOf(sessionFile);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "paste-1.md"), "previous");
    const store = createPasteFileStore();

    expect((await store.save({ sessionFile, text: "fresh" })).name).toBe("paste-2.md");
    expect((await store.save({ sessionFile, text: "next" })).name).toBe("paste-3.md");

    expect(await readFile(join(folder, "paste-1.md"), "utf8")).toBe("previous");
    expect(await readFile(join(folder, "paste-2.md"), "utf8")).toBe("fresh");
    expect(await readFile(join(folder, "paste-3.md"), "utf8")).toBe("next");
  });

  test("a new store starts after the files a previous run left, as a new omp controller does", async () => {
    const sessionFile = sessionFileIn(root);
    const first = createPasteFileStore();
    await first.save({ sessionFile, text: "one" });
    await first.save({ sessionFile, text: "two" });

    const later = await createPasteFileStore().save({ sessionFile, text: "three" });

    expect(later.name).toBe("paste-3.md");
  });

  test("the folder is the one omp's local:// resolver reads: the session file without .jsonl, then local", () => {
    expect(
      localRootOf(SessionFilePath.parse("/home/user/.omp/agent/sessions/-work/chat-1.jsonl")),
    ).toBe("/home/user/.omp/agent/sessions/-work/chat-1/local");
  });

  test("a folder that cannot be created fails with a plain message that names no path", async () => {
    const sessionFile = sessionFileIn(root);
    await mkdir(join(root, "sessions"), { recursive: true });
    // A file where the chat's folder should be: the local folder cannot be created inside it.
    await writeFile(sessionFile.slice(0, -".jsonl".length), "not a folder");

    const failure: unknown = await createPasteFileStore()
      .save({ sessionFile, text: "x" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppFailure);
    if (!(failure instanceof AppFailure)) throw new Error("expected an AppFailure");
    expect(failure.appError.code).toBe("internal");
    expect(failure.appError.message).toBe(
      "The pasted text could not be saved to the chat's folder.",
    );
    expect(failure.appError.message).not.toContain(root);
  });
});
