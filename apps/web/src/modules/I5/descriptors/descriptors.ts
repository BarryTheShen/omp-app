import type { Descriptor, SettingDescriptor } from "@omp-app/contracts";
import { I5_BROWSER_SPEECH_CAPABILITIES, I5_LIVE_CAPABILITY } from "../contract";
import { I5_SETTINGS_SECTIONS } from "../settings";

function settingDescriptor(section: (typeof I5_SETTINGS_SECTIONS)[number]): SettingDescriptor {
  const control = section.controls[0];
  if (!control) throw new Error(`I5 settings section ${section.id} has no controls.`);
  return {
    kind: "setting",
    id: section.id,
    owner: "I5",
    title: section.title,
    covers: [...section.inventory],
    requires: [...section.requires],
    key: control.key,
    section: section.section,
  };
}

export const I5_DESCRIPTORS = [
  {
    kind: "panel",
    id: "I5.liveVoice",
    owner: "I5",
    title: "Live voice",
    covers: ["D8.live-voice"],
    requires: [I5_LIVE_CAPABILITY],
  },
  {
    kind: "composer",
    id: "I5.speechToText",
    owner: "I5",
    title: "Speech-to-text dictation",
    covers: ["D8.speech-to-text-push-to-talk"],
    requires: [I5_BROWSER_SPEECH_CAPABILITIES.recognition],
    feature: { slot: "submission" },
  },
  {
    kind: "command",
    id: "I5.liveCommand",
    owner: "I5",
    title: "Live voice command",
    covers: ["C5.live"],
    requires: [I5_LIVE_CAPABILITY],
  },
  {
    kind: "status",
    id: "I5.liveVoiceFrames",
    owner: "I5",
    title: "Live voice transcript",
    covers: ["C5.live-voice-rpc-frames"],
    requires: [I5_LIVE_CAPABILITY],
  },
  ...I5_SETTINGS_SECTIONS.map(settingDescriptor),
] as const satisfies readonly Descriptor[];

export type I5Descriptor = (typeof I5_DESCRIPTORS)[number];
