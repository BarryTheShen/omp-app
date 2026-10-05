import type { MessageDescriptor } from "@omp-app/contracts";

/**
 * C0 descriptors for U1's normalized message roles. Domain modules register their own special
 * rows; these descriptors claim only the 29 F6 rows listed in research/modules/U1.md, exactly once.
 * `requires: []` is intentional: the renderer is useful for a loaded snapshot even when a later
 * history/runtime capability is unavailable.
 */
export const U1MessageDescriptors = [
  {
    id: "U1.userMessage",
    owner: "U1",
    title: "User message",
    kind: "message",
    match: { by: "role", role: "user" },
    covers: ["F6.user-prompt"],
    requires: [],
  },
  {
    id: "U1.developerMessage",
    owner: "U1",
    title: "Developer message",
    kind: "message",
    match: { by: "role", role: "developer" },
    covers: ["F6.synthetic-developer-prompt"],
    requires: [],
  },
  {
    id: "U1.assistantMessage",
    owner: "U1",
    title: "Assistant message",
    kind: "message",
    match: { by: "role", role: "assistant" },
    covers: [
      "F6.aborted-assistant-turn",
      "F6.assistant-native-image",
      "F6.assistant-provider-error",
      "F6.assistant-text",
      "F6.assistant-thinking-reasoning",
      "F6.hidden-thinking-streaming-pulse",
      "F6.retry-recovery-note",
    ],
    requires: [],
  },
  {
    id: "U1.customMessage",
    owner: "U1",
    title: "Custom extension message",
    kind: "message",
    match: { by: "role", role: "custom" },
    covers: [
      "F6.custom-extension-message",
      "F6.display-false-custom-continuity-message",
      "F6.display-false-prewalk-plan-nudge",
      "F6.generic-system-notification-custom-body",
      "F6.skill-invocation",
    ],
    requires: [],
  },
  {
    id: "U1.hookMessage",
    owner: "U1",
    title: "Hook message",
    kind: "message",
    match: { by: "role", role: "hookMessage" },
    covers: [],
    requires: [],
  },
  {
    id: "U1.fileMention",
    owner: "U1",
    title: "File mention",
    kind: "message",
    match: { by: "role", role: "fileMention" },
    covers: ["F6.file-mention-read-rows"],
    requires: [],
  },
  {
    id: "U1.toolResult",
    owner: "U1",
    title: "Tool result attachment",
    kind: "message",
    match: { by: "role", role: "toolResult" },
    covers: [
      "F6.stripped-tool-call-placeholder",
      "F6.tool-result-image",
      "F6.toolresult-message-attached",
    ],
    requires: [],
  },
  {
    id: "U1.sessionEntry",
    owner: "U1",
    title: "Session entry metadata",
    kind: "message",
    match: { by: "role", role: "session-entry" },
    covers: [
      "F6.session-entry-credential-pin",
      "F6.session-entry-custom-extension-state",
      "F6.session-entry-label-bookmark",
      "F6.session-entry-mode-change",
      "F6.session-entry-model-change",
      "F6.session-entry-reset-boundary",
      "F6.session-entry-service-tier-change",
      "F6.session-entry-session-init",
      "F6.session-entry-thinking-level-change",
      "F6.session-entry-title-change",
      "F6.session-entry-ttsr-injection",
    ],
    requires: [],
  },
] as const satisfies readonly MessageDescriptor[];

export type U1MessageDescriptor = (typeof U1MessageDescriptors)[number];

export const U1MessageDescriptorByRole = Object.fromEntries(
  U1MessageDescriptors.map((descriptor) => [descriptor.match.role, descriptor]),
) as Readonly<Record<string, U1MessageDescriptor>>;
