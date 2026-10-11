import { describe, expect, test } from "vitest";
import { itemOriginText } from "../../extensions/item-origin";

describe("itemOriginText: where an item came from, in plain words", () => {
  test("an extension in omp's own extensions folder is from your extensions folder", () => {
    expect(itemOriginText({ source: "extension", provider: "native" })).toBe(
      "From your extensions folder",
    );
  });

  test("a plugin is from a plugin, whichever package or folder provides it", () => {
    expect(itemOriginText({ source: "plugin", provider: "omp-plugins" })).toBe("From a plugin");
    expect(itemOriginText({ source: "plugin", provider: "demo-plugin" })).toBe("From a plugin");
  });

  test("a skill is from your skills folder, managed by omp, or from the plugin that brings it", () => {
    expect(itemOriginText({ source: "skill", provider: "native" })).toBe("From your skills folder");
    expect(itemOriginText({ source: "skill", provider: "omp-managed" })).toBe("Managed by omp");
    expect(itemOriginText({ source: "skill", provider: "demo-plugin" })).toBe("From a plugin");
  });

  test("a source or provider the catalog does not name reads as not known", () => {
    expect(itemOriginText({ source: "extension", provider: "demo-plugin" })).toBe(
      "Source not known",
    );
    expect(itemOriginText({ source: "plugin", provider: "unknown" })).toBe("Source not known");
    expect(itemOriginText({ source: "skill", provider: "unknown-provider" })).toBe(
      "Source not known",
    );
    expect(itemOriginText({ source: "tool", provider: "native" })).toBe("Source not known");
  });

  test("never shows omp's raw provider name", () => {
    for (const provider of [
      "native",
      "omp-managed",
      "omp-plugins",
      "demo-plugin",
      "unknown",
      "unknown-provider",
    ]) {
      for (const source of ["extension", "plugin", "skill"]) {
        expect(itemOriginText({ source, provider })).not.toContain(provider);
      }
    }
  });
});
