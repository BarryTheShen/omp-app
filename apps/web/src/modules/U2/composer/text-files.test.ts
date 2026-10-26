import type { Attachment } from "@assistant-ui/react";
import { describe, expect, test } from "vitest";
import { isTextFile, textOfAttachment, withReferences, withTextFilesSaved } from "./text-files";

function base64Of(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function stored(name: string, contentType: string, data: string): Attachment {
  return {
    id: name,
    type: contentType.startsWith("image/") ? "image" : "file",
    name,
    contentType,
    status: { type: "complete" },
    content: [{ type: "file", data, mimeType: contentType }],
  } as Attachment;
}

describe("text files attached in the composer (#2658)", () => {
  test("a text or Markdown file is one, a picture is not", () => {
    expect(isTextFile(stored("notes.txt", "text/plain", ""))).toBe(true);
    expect(isTextFile(stored("plan.md", "text/markdown", ""))).toBe(true);
    expect(isTextFile(stored("photo.png", "image/png", ""))).toBe(false);
  });

  test("its text is read from the stored data as UTF-8, characters of several bytes included", async () => {
    const text = "Résumé: 日本語 ✓\nline two";
    const attachment = stored(
      "notes.txt",
      "text/plain",
      `data:text/plain;base64,${base64Of(text)}`,
    );
    expect(await textOfAttachment(attachment)).toBe(text);
  });

  test("a file still being added is read from the file itself", async () => {
    const file = new File(["typed text"], "draft.md", { type: "text/markdown" });
    const attachment = {
      id: "a-1",
      type: "file",
      name: "draft.md",
      contentType: "text/markdown",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    } as Attachment;
    expect(await textOfAttachment(attachment)).toBe("typed text");
  });

  test("a file with nothing to read stops the send with a plain reason that names it", async () => {
    const attachment = {
      id: "a-2",
      type: "file",
      name: "lost.txt",
      contentType: "text/plain",
      status: { type: "complete" },
      content: [],
    } as unknown as Attachment;
    await expect(textOfAttachment(attachment)).rejects.toThrow(
      "lost.txt could not be read, so the message was not sent.",
    );
  });

  test("the references follow the typed text, one to a line, and stand alone when nothing was typed", () => {
    expect(withReferences("Summarize these.", ["local://a.txt", "local://b.md"])).toBe(
      "Summarize these.\n\nlocal://a.txt\nlocal://b.md",
    );
    expect(withReferences("", ["local://a.txt"])).toBe("local://a.txt");
    expect(withReferences("Just text", [])).toBe("Just text");
  });

  test("at send, each text file is saved, cited after the typed text, and leaves the attachments; a picture stays", async () => {
    const saved: { readonly name: string; readonly text: string }[] = [];
    const save = async (name: string, text: string): Promise<string> => {
      saved.push({ name, text });
      return `local://${name}`;
    };
    const notes = stored("notes.txt", "text/plain", `data:text/plain;base64,${base64Of("alpha")}`);
    const plan = stored(
      "plan.md",
      "text/markdown",
      `data:text/markdown;base64,${base64Of("# beta")}`,
    );
    const photo = stored("photo.png", "image/png", "data:image/png;base64,AAAA");
    const sending = await withTextFilesSaved("Read these.", [notes, photo, plan], save);
    expect(saved).toEqual([
      { name: "notes.txt", text: "alpha" },
      { name: "plan.md", text: "# beta" },
    ]);
    expect(sending.text).toBe("Read these.\n\nlocal://notes.txt\nlocal://plan.md");
    expect(sending.attachments).toEqual([photo]);
  });

  test("a file that cannot be saved stops the send with a plain reason that names it", async () => {
    const notes = stored("notes.txt", "text/plain", `data:text/plain;base64,${base64Of("alpha")}`);
    const save = async (): Promise<string> => {
      throw new Error("disk full");
    };
    await expect(withTextFilesSaved("Read it.", [notes], save)).rejects.toThrow(
      "notes.txt could not be saved for the agent to read, so the message was not sent.",
    );
  });

  test("a pasted-text chip is not a file the message cites: it is not saved, and stays for its wrapped block", async () => {
    const pasted = stored(
      "Pasted text 1 (3 lines).txt",
      "text/plain",
      `data:text/plain;base64,${base64Of("a\nb\nc")}`,
    );
    expect(isTextFile(pasted)).toBe(false);
    let saves = 0;
    const sending = await withTextFilesSaved("Look at this", [pasted], async () => {
      saves += 1;
      return "local://never.txt";
    });
    expect(saves).toBe(0);
    expect(sending).toEqual({ text: "Look at this", attachments: [pasted] });
  });
});
