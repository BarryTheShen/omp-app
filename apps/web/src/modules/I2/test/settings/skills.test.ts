import { describe, expect, test } from "vitest";
import {
  DEFAULT_SKILLS_REGISTRY_URL,
  I2_SETTINGS_SECTIONS,
  INTERACTION_SKILLS_SETTINGS_SECTION,
} from "../../settings";

describe("I2 Interaction / Skills settings", () => {
  test("registers the omp Skills group and registry default", () => {
    expect(I2_SETTINGS_SECTIONS).toEqual([INTERACTION_SKILLS_SETTINGS_SECTION]);
    expect(INTERACTION_SKILLS_SETTINGS_SECTION).toMatchObject({
      id: "I2.interactionSkills",
      section: "interaction/Skills",
      title: "Skills",
      inventory: ["S3.interaction-skills"],
      requires: ["host.config"],
    });
    expect(DEFAULT_SKILLS_REGISTRY_URL).toBe("https://skills.omp.sh");
    expect(INTERACTION_SKILLS_SETTINGS_SECTION.controls).toEqual([
      expect.objectContaining({
        key: "skills.registryUrl",
        label: "Skill Registry",
        kind: "text",
        apply: "live",
        secret: false,
      }),
    ]);
  });

  test("accepts secure registry URLs with paths and rejects unsafe addresses", () => {
    const control = INTERACTION_SKILLS_SETTINGS_SECTION.controls[0];
    if (!control) throw new Error("Missing Skills registry control.");
    const snapshot = { folder: null, revision: "test", entries: [] } as const;
    expect(
      control.validate({ secret: false, value: DEFAULT_SKILLS_REGISTRY_URL }, snapshot),
    ).toEqual({
      valid: true,
    });
    expect(control.validate({ secret: false, value: "http://localhost:4173" }, snapshot)).toEqual({
      valid: true,
    });
    expect(
      control.validate({ secret: false, value: "https://registry.example/skills" }, snapshot),
    ).toEqual({ valid: true });
    expect(
      control.validate({ secret: false, value: "http://registry.example" }, snapshot).valid,
    ).toBe(false);
    expect(
      control.validate({ secret: false, value: "https://user:pass@registry.example" }, snapshot)
        .valid,
    ).toBe(false);
    expect(
      control.validate({ secret: false, value: "https://registry.example?preview=1" }, snapshot)
        .valid,
    ).toBe(false);
    expect(
      control.validate({ secret: false, value: "https://:secret@registry.example" }, snapshot)
        .valid,
    ).toBe(false);
    expect(
      control.validate({ secret: false, value: "https://registry.example/#readme" }, snapshot)
        .valid,
    ).toBe(false);
    // A hand-edited config can hold a number or a list; the field says so instead of throwing.
    expect(control.validate({ secret: false, value: 42 }, snapshot).valid).toBe(false);
    expect(
      control.validate({ secret: false, value: ["https://registry.example"] }, snapshot).valid,
    ).toBe(false);
  });
});
