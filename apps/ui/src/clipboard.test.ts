import { afterEach, describe, expect, test, vi } from "vitest";
import { writeClipboard } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The browser's clipboard: what it took, and whether it refuses (as VS Code's webview refuses the app's page). */
function browserClipboard(refuses: boolean) {
  const written: string[] = [];
  const refusal = new DOMException("Write permission denied.", "NotAllowedError");
  const writeText = vi.fn(async (text: string) => {
    if (refuses) throw refusal;
    written.push(text);
  });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return { written, refusal };
}

/** The frame's host: what it was asked to copy, and its answer. */
function frameHost(copies: boolean) {
  const asked: string[] = [];
  return {
    asked,
    host: {
      copy: async (text: string) => {
        asked.push(text);
        return copies;
      },
    },
  };
}

describe("writeClipboard", () => {
  test("the browser's clipboard takes the text; the host is not asked", async () => {
    const { written } = browserClipboard(false);
    const { asked, host } = frameHost(true);
    await writeClipboard("const x = 1;", host);
    expect(written).toEqual(["const x = 1;"]);
    expect(asked).toEqual([]);
  });

  test("where the browser's clipboard refuses the page (VS Code's webview), the frame's host copies it", async () => {
    browserClipboard(true);
    const { asked, host } = frameHost(true);
    await writeClipboard("const x = 1;", host);
    expect(asked).toEqual(["const x = 1;"]);
  });

  test("when the host cannot copy either, or there is none, the browser's refusal is the error", async () => {
    const { refusal } = browserClipboard(true);
    await expect(writeClipboard("const x = 1;", frameHost(false).host)).rejects.toBe(refusal);
    await expect(writeClipboard("const x = 1;", null)).rejects.toBe(refusal);
  });

  test("text the server gives is copied once it comes, through the host too; its failure is the copy's error", async () => {
    browserClipboard(true);
    const { asked, host } = frameHost(true);
    await writeClipboard(Promise.resolve("secret-value-0123"), host);
    expect(asked).toEqual(["secret-value-0123"]);
    const gone = new Error("No secret is named API_KEY.");
    await expect(writeClipboard(Promise.reject(gone), host)).rejects.toBe(gone);
    expect(asked).toEqual(["secret-value-0123"]);
  });
});
