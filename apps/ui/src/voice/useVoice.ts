import type { AppClient } from "@omp-app/client";
import { type SpeechSettingsRead, SpeechToTextPort } from "@omp-app/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { follow } from "../follow";
import { canCapture } from "./capture";
import { VoiceSession, type VoiceSnapshot } from "./session";

/** One voice session for each connection, shared by every message box of the page: one recording at a time. */
const sessions = new WeakMap<AppClient, VoiceSession>();

export function voiceSession(client: AppClient): VoiceSession {
  let session = sessions.get(client);
  if (session === undefined) {
    session = new VoiceSession(client);
    sessions.set(client, session);
  }
  return session;
}

export function useVoice(client: AppClient): { session: VoiceSession; snapshot: VoiceSnapshot } {
  const session = voiceSession(client);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { session, snapshot };
}

/** Voice input's settings as the server keeps them, kept current; null until read (or when the server lacks them). */
export function useVoiceSettings(client: AppClient): SpeechSettingsRead | null {
  const [settings, setSettings] = useState<SpeechSettingsRead | null>(null);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      client
        .port(SpeechToTextPort)
        .settings({})
        .then(
          (next) => active && setSettings(next),
          () => undefined,
        );
    };
    read();
    const stop = follow(client.subscribe(SpeechToTextPort, "settingsChanged"), (next) =>
      setSettings(next),
    );
    const stopOutage = client.onOutage(read);
    return () => {
      active = false;
      stop();
      stopOutage();
    };
  }, [client]);
  return settings;
}

/** Whether the mic button shows: voice input on, a server named, and a browser that can capture. */
export function useVoiceAvailable(client: AppClient): boolean {
  const settings = useVoiceSettings(client);
  return (
    settings?.settings.enabled === true && settings.settings.servers.length > 0 && canCapture()
  );
}
