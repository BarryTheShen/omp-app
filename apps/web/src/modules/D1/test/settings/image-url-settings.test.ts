import type { JsonValue } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingControl } from "@/modules/S1/settings-kit";
import { validate } from "@/modules/S1/settings-kit";
import { modelSettingsSections } from "../../settings/descriptors";

const snapshot: ConfigSnapshot = { folder: null, revision: "r", entries: [] };
const IMAGE_URL_KEYS = [
  "images.urls.enabled",
  "images.urls.backends",
  "images.urls.command",
  "images.urls.publicBaseUrl",
  "images.urls.ttlHours",
  "images.urls.bindHost",
  "images.urls.sshTarget",
  "images.urls.sshRemotePort",
] as const;

function controlFor(key: string): SettingControl {
  const control = modelSettingsSections
    .flatMap((section) => section.controls)
    .find((candidate) => candidate.key === key);
  if (control === undefined) throw new Error(`Image URL setting is missing: ${key}`);
  return control;
}

describe("image URL settings", () => {
  test("places every supported omp image URL key in Vision with its omp label and live apply", () => {
    const section = modelSettingsSections.find((candidate) => candidate.section === "model/Vision");
    expect(section?.controls.map((control) => control.key)).toEqual([
      "images.describeForTextModels",
      ...IMAGE_URL_KEYS,
    ]);
    expect(controlFor("images.urls.enabled").label).toBe("Serve Images as URLs");
    expect(controlFor("images.urls.backends").label).toBe("Image URL Backends");
    expect(controlFor("images.urls.command").label).toBe("Image Upload Command");
    expect(controlFor("images.urls.publicBaseUrl").label).toBe("Image URL Public Base");
    expect(controlFor("images.urls.ttlHours").label).toBe("Image URL Lifetime (hours)");
    expect(controlFor("images.urls.bindHost").label).toBe("Image URL Bind Host");
    expect(controlFor("images.urls.sshTarget").label).toBe("Image URL SSH Target");
    expect(controlFor("images.urls.sshRemotePort").label).toBe("Image URL SSH Remote Port");
    for (const key of IMAGE_URL_KEYS) expect(controlFor(key).apply, key).toBe("live");
  });

  test("validates and stages a value for every supported key", () => {
    const values: Record<(typeof IMAGE_URL_KEYS)[number], JsonValue> = {
      "images.urls.enabled": true,
      "images.urls.backends": ["provider-files", "tailscale"],
      "images.urls.command": "pasta -b -f {file}",
      "images.urls.publicBaseUrl": "https://images.example.test",
      "images.urls.ttlHours": 72,
      "images.urls.bindHost": "127.0.0.1",
      "images.urls.sshTarget": "user@image-host",
      "images.urls.sshRemotePort": 8787,
    };
    for (const key of IMAGE_URL_KEYS) {
      expect(
        validate(controlFor(key), { secret: false, value: values[key] }, snapshot),
        key,
      ).toEqual({
        valid: true,
      });
    }
  });

  test.each([
    [-1, "Enter a whole number, 0 or more."],
    [1.5, "Enter a whole number, 0 or more."],
  ])("rejects image URL lifetime %s with its validation sentence", (value, message) => {
    expect(
      validate(controlFor("images.urls.ttlHours"), { secret: false, value }, snapshot),
    ).toEqual({ valid: false, code: "range", message });
  });

  test.each([
    [0, "Enter a whole number from 1 to 65535."],
    [70000, "Enter a whole number from 1 to 65535."],
  ])("rejects image URL SSH port %s with its validation sentence", (value, message) => {
    expect(
      validate(controlFor("images.urls.sshRemotePort"), { secret: false, value }, snapshot),
    ).toEqual({ valid: false, code: "range", message });
  });

  test.each([1, 65535])("accepts image URL SSH port boundary %s", (value) => {
    expect(
      validate(controlFor("images.urls.sshRemotePort"), { secret: false, value }, snapshot),
    ).toEqual({ valid: true });
  });

  test("rejects a non-text image URL command with its validation sentence", () => {
    expect(
      validate(controlFor("images.urls.command"), { secret: false, value: false }, snapshot),
    ).toEqual({ valid: false, code: "text", message: "Enter text." });
  });
});
