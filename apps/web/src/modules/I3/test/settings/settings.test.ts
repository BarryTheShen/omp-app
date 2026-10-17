import { INVENTORY } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { MEMORY_SETTINGS_SECTIONS } from "../../settings";
import { MEMORY_REGISTRY_EXTRACT } from "../../settings/registry";

describe("I3 memory settings descriptors", () => {
  test("matches the committed omp registry extract and inventory sections", () => {
    for (const section of MEMORY_SETTINGS_SECTIONS) {
      const registry =
        MEMORY_REGISTRY_EXTRACT[section.section as keyof typeof MEMORY_REGISTRY_EXTRACT];
      expect(registry).toBeDefined();
      expect(section.controls.map((control) => control.key)).toEqual(
        registry.controls.map((control) => control.key),
      );
      for (const [index, control] of section.controls.entries()) {
        const values =
          control.kind === "enum" ? (control.options?.map((option) => option.value) ?? []) : [];
        expect(values).toEqual(registry.controls[index]?.values ?? []);
      }
      expect(section.inventory).toEqual(
        INVENTORY.filter((item) => item.id === section.inventory[0]).map((item) => item.id),
      );
    }
    expect(MEMORY_SETTINGS_SECTIONS.flatMap((section) => section.controls)).toHaveLength(
      MEMORY_SETTINGS_SECTIONS.reduce(
        (count, section) =>
          count +
          MEMORY_REGISTRY_EXTRACT[section.section as keyof typeof MEMORY_REGISTRY_EXTRACT].controls
            .length,
        0,
      ),
    );
  });

  test("requires host config and keeps credentials status-only", () => {
    expect(
      MEMORY_SETTINGS_SECTIONS.every((section) => section.requires.join() === "host.config"),
    ).toBe(true);
    const secrets = MEMORY_SETTINGS_SECTIONS.flatMap((section) =>
      section.controls.filter((control) => control.secret),
    );
    expect(secrets.map((control) => control.key)).toEqual([
      "hindsight.apiToken",
      "mnemopi.embeddingApiKey",
      "mnemopi.llmApiKey",
    ]);
    expect(secrets.every((control) => control.kind === "secret")).toBe(true);
  });

  test("uses omp's labels and the scoping values of the registry extract", () => {
    const controls = MEMORY_SETTINGS_SECTIONS.flatMap((section) => section.controls);
    expect(controls.find((control) => control.key === "sharpshooter.model")?.label).toBe(
      "Sharpshooter Model",
    );
    expect(controls.find((control) => control.key === "mnemopi.llmModel")?.label).toBe(
      "Mnemopi LLM Model",
    );
    expect(
      MEMORY_REGISTRY_EXTRACT["memory/Mnemopi"].controls.find(
        (control) => control.key === "mnemopi.scoping",
      )?.values,
    ).toEqual(["global", "per-project", "per-project-tagged"]);
  });

  test("uses omp's full names for embedding variants and model choices", () => {
    const controls = MEMORY_SETTINGS_SECTIONS.flatMap((section) => section.controls);
    const embeddingVariant = controls.find((control) => control.key === "mnemopi.embeddingVariant");
    if (embeddingVariant?.kind !== "enum") throw new Error("Missing embedding variant enum.");
    expect(embeddingVariant.options).toEqual([
      { value: "en", label: "English (bge-base-en-v1.5)" },
      { value: "multilingual", label: "Multilingual (multilingual-e5-large)" },
    ]);
    const llmMode = controls.find((control) => control.key === "mnemopi.llmMode");
    if (llmMode?.kind !== "enum") throw new Error("Missing LLM mode enum.");
    expect(llmMode.options).toEqual([
      { value: "none", label: "None" },
      { value: "smol", label: "Online (tiny)" },
      { value: "remote", label: "Remote" },
    ]);
  });
});
