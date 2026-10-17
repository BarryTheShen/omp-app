import type {
  CommandDescriptor,
  Descriptor,
  MessageDescriptor,
  SettingDescriptor,
  StatusDescriptor,
} from "@omp-app/contracts";
import { COLLABORATION_CAPABILITY } from "../contract";
import { STREAM_SETTINGS_SECTION } from "../settings/stream-descriptor";

const AP6 = [COLLABORATION_CAPABILITY] as const;

const command = (
  id: CommandDescriptor["id"],
  title: string,
  covers: CommandDescriptor["covers"],
  slash?: string,
): CommandDescriptor => ({
  kind: "command",
  id,
  owner: "I4",
  title,
  covers,
  requires: [...AP6],
  ...(slash === undefined ? {} : { slash: { name: slash, source: "builtin" as const } }),
});

export const I4_COMMAND_DESCRIPTORS = [
  command("I4.collabCommand", "Collaboration", ["C5.collab"], "collab"),
  command("I4.join", "Join collaboration", ["C5.join"], "join"),
  command("I4.leave", "Leave collaboration", ["C5.leave"], "leave"),
  command("I4.collabStatus", "Collaboration status", ["C5.collab-status"]),
  command("I4.collabStop", "Stop collaboration", ["C5.collab-stop"]),
  command("I4.collabView", "Create a view link", ["C5.collab-view"]),
] as const satisfies readonly CommandDescriptor[];

export const I4_ROLE_DESCRIPTOR: StatusDescriptor = {
  kind: "status",
  id: "I4.collaborationHostGuest",
  owner: "I4",
  title: "Collaboration role",
  covers: ["C5.collaboration-host-guest"],
  requires: [...AP6],
};

/**
 * omp v18.8.9 writes a guest's prompt into the transcript as a custom message of type `collab-prompt`
 * (`packages/wire/src/index.ts:170`, written at `packages/coding-agent/src/collab/host.ts:996`). The typed AP6 prompt
 * that `GuestPromptRow` renders reaches the row through the main agent's composition, not through this match.
 */
export const I4_GUEST_PROMPT_DESCRIPTOR: MessageDescriptor = {
  kind: "message",
  id: "I4.collabGuestPrompt",
  owner: "I4",
  title: "Shared guest prompt",
  covers: ["C5.collab-guest-prompt"],
  requires: [...AP6],
  match: { by: "customType", customType: "collab-prompt" },
};

const streamKey = STREAM_SETTINGS_SECTION.controls[0]?.key;
if (streamKey === undefined) throw new Error("I4 stream settings section has no controls.");

export const I4_STREAM_DESCRIPTOR: SettingDescriptor = {
  kind: "setting",
  id: "I4.interactionStream",
  owner: "I4",
  title: STREAM_SETTINGS_SECTION.title,
  covers: [...STREAM_SETTINGS_SECTION.inventory],
  requires: [...STREAM_SETTINGS_SECTION.requires],
  key: streamKey,
  section: STREAM_SETTINGS_SECTION.section,
};

export const I4_DESCRIPTORS: readonly Descriptor[] = [
  ...I4_COMMAND_DESCRIPTORS,
  I4_ROLE_DESCRIPTOR,
  I4_GUEST_PROMPT_DESCRIPTOR,
  I4_STREAM_DESCRIPTOR,
];
