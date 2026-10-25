import type { AppClient } from "@omp-app/client";
import { AppFailure, checkScrubbed, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { SettingsRuntime } from "@/modules/S1/runtime";
import type { ConfigStoreClient } from "@/modules/S1/settings-kit";
import {
  finalizeVoiceTranscript,
  I5_BROWSER_SPEECH_CAPABILITIES,
  I5_LIVE_CAPABILITY,
} from "../../contract";
import { I5_DESCRIPTORS } from "../../descriptors";
import {
  CONFIG_STORE_FIXTURE,
  LIVE_FINAL_TRANSCRIPT,
  LIVE_RPC_FIXTURE,
  LIVE_STATE_FIXTURE,
  OMP_V18_12_6_UI_SETTING_KEYS,
} from "../../fixtures";
import { createLiveVoiceAdapter } from "../../live";
import { I5_SETTINGS_SECTIONS } from "../../settings";

const I5_ROWS = [
  "D8.live-voice",
  "D8.speech-to-text-push-to-talk",
  "C5.live",
  "C5.live-voice-rpc-frames",
  "S3.interaction-speech",
  "S5.providers-services",
] as const;

describe("I5 W5 gate", () => {
  test("CC12: every I5 row is covered exactly once", () => {
    expect(I5_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual([...I5_ROWS]);
  });

  test("CC2: every control is capability-gated", () => {
    expect(I5_DESCRIPTORS.every((descriptor) => descriptor.requires.length > 0)).toBe(true);
    expect(I5_DESCRIPTORS.find((descriptor) => descriptor.id === "I5.liveVoice")?.requires).toEqual(
      [I5_LIVE_CAPABILITY],
    );
    expect(
      I5_DESCRIPTORS.find((descriptor) => descriptor.id === "I5.speechToText")?.requires,
    ).toEqual([I5_BROWSER_SPEECH_CAPABILITIES.recognition]);
  });

  test("CC4 and CC6: descriptors validate and finalized voice text is the only admitted text", () => {
    expect(validateRegistry(I5_DESCRIPTORS)).toEqual([]);
    expect(finalizeVoiceTranscript({ ...LIVE_FINAL_TRANSCRIPT, final: false })).toBeNull();
    expect(finalizeVoiceTranscript(LIVE_FINAL_TRANSCRIPT)).toMatchObject({
      id: "voice:live-fixture:user:0",
      metadata: { modality: "voice" },
    });
  });
  test("typed live frames replay through the adapter and admit the final transcript once", async () => {
    const listeners = new Set<(event: unknown) => void>();
    const client = {
      port: () => ({ send: async () => ({ voice: "arbor" }) }),
      subscribe: async () => ({
        onEvent: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        unsubscribe: async () => undefined,
      }),
    } as unknown as AppClient;
    const adapter = createLiveVoiceAdapter({
      client,
      threadId: "i5-fixture" as never,
      capabilities: { [I5_LIVE_CAPABILITY]: { state: "available" as const, via: "rpc" as const } },
      sessionIdFactory: () => "live-fixture",
    });
    const finals: unknown[] = [];
    adapter.onFinalTranscript((message) => finals.push(message));
    await adapter.start();
    for (const frame of LIVE_RPC_FIXTURE)
      for (const listener of listeners) listener({ kind: "notification", frame });
    expect(adapter.getSnapshot().phase).toBe("error");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ id: "voice:live-fixture:user:0" });
    await adapter.dispose();
  });

  test("stale ConfigStore revisions run through SettingsRuntime and keep local edits", async () => {
    const section = I5_SETTINGS_SECTIONS[1];
    if (!section) throw new Error("Missing providers/services section.");
    let listCalls = 0;
    const client: ConfigStoreClient = {
      read: async ({ key }) => {
        const entry = CONFIG_STORE_FIXTURE.entries.find((candidate) => candidate.key === key);
        if (!entry)
          throw new AppFailure({ code: "not_found", message: "Missing", retryable: false });
        return entry;
      },
      list: async () => {
        listCalls += 1;
        if (listCalls === 1) return CONFIG_STORE_FIXTURE;
        return {
          ...CONFIG_STORE_FIXTURE,
          entries: CONFIG_STORE_FIXTURE.entries.map((entry) =>
            entry.key === "live.voice" && !entry.secret ? { ...entry, value: "juniper" } : entry,
          ),
        };
      },
      write: async () => {
        throw new AppFailure({
          code: "conflict",
          message: "Settings changed elsewhere",
          retryable: true,
        });
      },
    };
    const runtime = new SettingsRuntime(
      client,
      { subscribe: () => () => undefined },
      { descriptor: section, folder: null, layer: "global" },
    );
    try {
      await runtime.read();
      expect(runtime.stage("live.voice", { secret: false, value: "sol" }).ok).toBe(true);
      await expect(runtime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
      expect(runtime.getSnapshot().phase).toBe("conflict");
      expect(runtime.getSnapshot().conflict).toMatchObject({
        local: { edits: { "live.voice": { secret: false, value: "sol" } } },
      });
      expect(runtime.getSnapshot().conflict?.remote.entries).toHaveLength(1);
      expect(
        runtime.getSnapshot().conflict?.remote.entries.find((entry) => entry.key === "live.voice"),
      ).toMatchObject({ value: "juniper" });
    } finally {
      runtime.dispose();
    }
  });
  test("fixture values are scrubbed and secrets are status-only", () => {
    expect(checkScrubbed(JSON.stringify(LIVE_RPC_FIXTURE))).toEqual([]);
    expect(checkScrubbed(JSON.stringify(LIVE_STATE_FIXTURE))).toEqual([]);
    expect(checkScrubbed(JSON.stringify(CONFIG_STORE_FIXTURE))).toEqual([]);
    expect(CONFIG_STORE_FIXTURE.entries).toContainEqual({
      key: "searxng.token",
      secret: true,
      isSet: true,
      source: "env",
      overrides: ["default"],
    });
  });

  test("the app registers every settings key omp v18.12.6 shows, plus one intentional extra", () => {
    const registered = I5_SETTINGS_SECTIONS.flatMap((section) =>
      section.controls.map((control) => control.key),
    );
    expect(OMP_V18_12_6_UI_SETTING_KEYS.filter((key) => !registered.includes(key))).toEqual([]);
    // omp registers stt.language without a settings ui; the app lists it with the services.
    expect(registered.filter((key) => !OMP_V18_12_6_UI_SETTING_KEYS.includes(key))).toEqual([
      "stt.language",
    ]);
  });
});
