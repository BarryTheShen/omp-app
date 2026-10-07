import { afterEach, describe, expect, test, vi } from "vitest";
import { saveTextFile } from "./save-file";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("saveTextFile", () => {
  test("downloads the text under the given name, then lets go of the object address", () => {
    vi.useFakeTimers();
    const created: Blob[] = [];
    const revoked: string[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        created.push(blob);
        return "blob:fake-address";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (address: string) => revoked.push(address),
    });
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });

    saveTextFile("omp-app-debug-20261007-070000.log", "hello report");

    expect(clicked).toEqual([
      { href: "blob:fake-address", download: "omp-app-debug-20261007-070000.log" },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("text/plain;charset=utf-8");
    // The link is removed from the page, and the address is revoked once the click has run.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(["blob:fake-address"]);
  });
});
