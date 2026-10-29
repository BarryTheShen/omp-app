import type { ConfigListResult, ConfigStore, PortClient } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  type ConfigSnapshot,
  SettingsSection,
  type SettingsSectionDescriptor,
  secretSummary,
} from "../../../S1/settings-kit";
import {
  I5_SETTING_KEYS,
  I5_SETTINGS_SECTIONS,
  INTERACTION_SPEECH_SECTION,
  PROVIDERS_SERVICES_SECTION,
} from "../../settings";
import { I5SettingsPanel } from "../../settings/panel";

const EXPECTED_SPEECH_KEYS = ["stt.enabled", "stt.submitTrigger"];
const EXPECTED_SERVICE_KEYS = [
  "live.voice",
  "stt.language",
  "tts.localVoice",
  "tts.localSpeed",
  "speech.enabled",
  "speech.mode",
  "speech.enhanced",
  "speech.voice",
  "speech.speed",
  "providers.maxInFlightRequests",
  "providers.ollama-cloud.maxConcurrency",
  "providers.webSearchTimeoutSeconds",
  "providers.antigravityEndpoint",
  "providers.fetch",
  "codexResets.autoRedeem",
  "codexResets.minBlockedMinutes",
  "codexResets.keepCredits",
  "codexResets.salvageHorizonHours",
  "claudeResets.autoRedeem",
  "claudeResets.minBlockedMinutes",
  "claudeResets.keepCredits",
  "claudeResets.salvageHorizonHours",
  "exa.enabled",
  "exa.searchDelayMs",
  "searxng.endpoint",
];

const snapshot: ConfigSnapshot = {
  folder: null,
  revision: "i5-revision-1",
  entries: [
    { key: "stt.enabled", secret: false, value: true, source: "project", overrides: ["global"] },
    { key: "stt.submitTrigger", secret: false, value: "never", source: "default", overrides: [] },
    { key: "live.voice", secret: false, value: "sol", source: "global", overrides: ["default"] },
    { key: "stt.language", secret: false, value: "en", source: "project", overrides: [] },
    { key: "tts.localVoice", secret: false, value: "af_heart", source: "default", overrides: [] },
    { key: "speech.mode", secret: false, value: "assistant", source: "default", overrides: [] },
    { key: "speech.voice", secret: false, value: "af_heart", source: "default", overrides: [] },
    {
      key: "providers.maxInFlightRequests",
      secret: false,
      value: { openai: 4 },
      source: "global",
      overrides: [],
    },
    {
      key: "searxng.token",
      secret: true,
      isSet: true,
      source: "global",
      overrides: [],
    },
  ],
};

function configClient(): PortClient<typeof ConfigStore> {
  const result: ConfigListResult = { entries: [...snapshot.entries], revision: snapshot.revision };
  return {
    read: async ({ key }) => {
      const entry = snapshot.entries.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`Missing ${key}`);
      return entry;
    },
    list: async () => result,
    write: async (args) =>
      ({
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        revision: "i5-revision-2",
        previousRevision: snapshot.revision,
        entry: {
          key: args.key,
          secret: false,
          value: args.value.secret ? null : args.value.value,
          source: args.layer,
          overrides: [],
        },
      }) as never,
    unset: async () => {
      throw new Error("The speech and services settings never take a value out.");
    },
  };
}

afterEach(() => cleanup());

describe("I5 settings descriptors", () => {
  test("covers the two owned inventory sections and exact v18.12.6 keys", () => {
    expect(I5_SETTINGS_SECTIONS).toHaveLength(2);
    expect(INTERACTION_SPEECH_SECTION.inventory).toEqual(["S3.interaction-speech"]);
    expect(PROVIDERS_SERVICES_SECTION.inventory).toEqual(["S5.providers-services"]);
    expect(I5_SETTING_KEYS).toEqual([EXPECTED_SPEECH_KEYS, EXPECTED_SERVICE_KEYS]);
    expect(PROVIDERS_SERVICES_SECTION.controls).toHaveLength(25);
    expect(PROVIDERS_SERVICES_SECTION.requires).toEqual(["host.config"]);
  });

  test("validates enum, JSON record, URL, number and list boundaries", () => {
    const control = (key: string) =>
      I5_SETTINGS_SECTIONS.flatMap((section) => section.controls).find(
        (candidate) => candidate.key === key,
      );
    const requireControl = (key: string) => {
      const found = control(key);
      if (!found) throw new Error(`Missing control ${key}`);
      return found;
    };
    expect(
      requireControl("stt.submitTrigger").validate(
        { secret: false, value: "say-submit" },
        snapshot,
      ),
    ).toEqual({ valid: true });
    expect(
      requireControl("stt.submitTrigger").validate({ secret: false, value: "immediate" }, snapshot),
    ).toMatchObject({ valid: false, code: "enum" });
    expect(
      requireControl("providers.maxInFlightRequests").validate(
        { secret: false, value: { openai: 4, anthropic: 2.5 } },
        snapshot,
      ),
    ).toEqual({ valid: true });
    expect(
      requireControl("providers.maxInFlightRequests").validate(
        { secret: false, value: { openai: 0 } },
        snapshot,
      ),
    ).toMatchObject({ valid: false, code: "record" });
    expect(
      requireControl("searxng.endpoint").validate(
        { secret: false, value: "https://search.example.test" },
        snapshot,
      ),
    ).toEqual({ valid: true });
    expect(
      requireControl("searxng.endpoint").validate(
        { secret: false, value: "file:///secret" },
        snapshot,
      ),
    ).toMatchObject({ valid: false, code: "url" });
    expect(
      requireControl("exa.searchDelayMs").validate({ secret: false, value: -1 }, snapshot),
    ).toMatchObject({ valid: false, code: "range" });
    expect(
      requireControl("tts.localSpeed").validate({ secret: false, value: 0.5 }, snapshot),
    ).toEqual({ valid: true });
    expect(
      requireControl("tts.localSpeed").validate({ secret: false, value: 0.4 }, snapshot),
    ).toMatchObject({ valid: false, code: "range" });
    expect(
      requireControl("speech.speed").validate({ secret: false, value: 1.25 }, snapshot),
    ).toEqual({ valid: true });
    expect(
      requireControl("speech.speed").validate({ secret: false, value: 2.5 }, snapshot),
    ).toEqual({ valid: true });
    expect(
      requireControl("speech.speed").validate({ secret: false, value: 2.6 }, snapshot),
    ).toMatchObject({ valid: false, code: "range" });
    expect(
      requireControl("tts.localSpeed").validate({ secret: false, value: 2.6 }, snapshot),
    ).toMatchObject({ valid: false, code: "range" });
    expect(requireControl("tts.localSpeed").label).toBe("Local TTS Speed");
    expect(requireControl("speech.speed").label).toBe("Speech Vocalization Speed");
  });

  test("marks live, session, reload and restart apply boundaries", () => {
    const control = (key: string) =>
      I5_SETTINGS_SECTIONS.flatMap((section) => section.controls).find(
        (candidate) => candidate.key === key,
      );
    expect(control("stt.enabled")?.apply).toBe("live");
    expect(control("speech.enhanced")?.apply).toBe("session");
    expect(control("providers.fetch")?.apply).toBe("reload");
    expect(control("searxng.endpoint")?.apply).toBe("restart");
    // The speech voice settings of the same section apply live; the two speed settings follow them.
    expect(control("tts.localSpeed")?.apply).toBe("live");
    expect(control("speech.speed")?.apply).toBe("live");
  });

  test("keeps secret ConfigStore entries write-only", () => {
    const entry = snapshot.entries.find((candidate) => candidate.key === "searxng.token");
    if (!entry?.secret) throw new Error("secret fixture missing");
    expect(secretSummary(entry)).toEqual({ isSecret: true, isSet: true, source: "global" });
    expect("value" in entry).toBe(false);
    expect(JSON.stringify(entry)).not.toContain("secret-value");
  });
});

describe("I5 settings panel", () => {
  test("loads both ConfigStore-backed sections and keeps CAS revisions internal", async () => {
    render(<I5SettingsPanel client={configClient()} folder={null} layer="global" />);
    expect(await screen.findByRole("heading", { name: "Voice and speech" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Speech" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Services" })).toBeTruthy();
    expect(screen.queryByText("i5-revision-1")).toBeNull();
    expect(
      (screen.getByLabelText("Max In-Flight Requests: Provider name 1") as HTMLInputElement).value,
    ).toBe("openai");
    expect(
      (screen.getByLabelText("Max In-Flight Requests: Request limit 1") as HTMLInputElement).value,
    ).toBe("4");
    expect(screen.queryByDisplayValue('{"openai":4}')).toBeNull();
    expect(screen.getByTestId("live.voice-provenance").textContent).toContain(
      "Source: Saved for all projects",
    );
    expect(screen.getByRole("combobox", { name: "Local TTS Voice" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Local TTS Speed" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Speech Vocalization Speed" })).toBeTruthy();
    expect(screen.queryByText("searxng.token")).toBeNull();
  });

  test("settings kit secret control remains masked", () => {
    const descriptor: SettingsSectionDescriptor = {
      ...INTERACTION_SPEECH_SECTION,
      id: "I5.secretTest",
      title: "Secret test",
      inventory: [],
      controls: [
        {
          key: "searxng.token",
          label: "SearXNG token",
          kind: "secret" as const,
          secret: true,
          validate: () => ({ valid: true as const }),
          apply: "reload" as const,
        },
      ],
    };
    render(<SettingsSection descriptor={descriptor} snapshot={snapshot} />);
    expect(screen.getByTestId("searxng.token-secret-status").textContent).toContain("Set");
    expect(screen.queryByDisplayValue(/secret|token/i)).toBeNull();
  });
});
