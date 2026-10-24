import { afterEach, describe, expect, test, vi } from "vitest";
import { pastedPictureName, readDesktopClipboardPicture } from "./clipboard-pictures";

/** The desktop window's bridge on this page, answering its command with `invoke`. Returns the spy on that command. */
function desktopBridge(invoke: (command: string) => Promise<unknown>) {
  const spy = vi.fn(invoke);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: spy },
  });
  return spy;
}

/** The first bytes of a PNG: enough to be a picture here, since the composer does not decode it. */
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer;

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("readDesktopClipboardPicture", () => {
  test("in the desktop window, a picture on the clipboard is a PNG file named for its paste", async () => {
    const invoke = desktopBridge(async () => PNG);

    const file = await readDesktopClipboardPicture(1);

    expect(invoke).toHaveBeenCalledWith("read_clipboard_png");
    expect(file?.name).toBe("Pasted image 1.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBe(PNG.byteLength);
  });

  test("in a browser there is no bridge, so nothing is read and the answer is null", async () => {
    await expect(readDesktopClipboardPicture(1)).resolves.toBeNull();
  });

  test("an empty answer means the clipboard holds no picture, so nothing is attached", async () => {
    const invoke = desktopBridge(async () => new ArrayBuffer(0));

    await expect(readDesktopClipboardPicture(1)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("a read the window refuses rejects, so the composer can say so", async () => {
    const refused = new Error("The clipboard is busy");
    desktopBridge(async () => {
      throw refused;
    });

    await expect(readDesktopClipboardPicture(1)).rejects.toBe(refused);
  });
});

describe("pastedPictureName", () => {
  test("names a pasted picture by its number and its file extension", () => {
    expect(pastedPictureName(1, "image/png")).toBe("Pasted image 1.png");
    expect(pastedPictureName(2, "image/jpeg")).toBe("Pasted image 2.jpeg");
    expect(pastedPictureName(3, "image/svg+xml")).toBe("Pasted image 3.svg");
  });

  test("a picture type with no subtype is named as a PNG", () => {
    expect(pastedPictureName(4, "image/")).toBe("Pasted image 4.png");
  });
});
