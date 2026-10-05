import { MessageDescriptor } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { U1MessageDescriptorByRole, U1MessageDescriptors } from "../../registry/messages";

const EXPECTED_F6_IDS = [
  "F6.aborted-assistant-turn",
  "F6.assistant-native-image",
  "F6.assistant-provider-error",
  "F6.assistant-text",
  "F6.assistant-thinking-reasoning",
  "F6.custom-extension-message",
  "F6.display-false-custom-continuity-message",
  "F6.display-false-prewalk-plan-nudge",
  "F6.file-mention-read-rows",
  "F6.generic-system-notification-custom-body",
  "F6.hidden-thinking-streaming-pulse",
  "F6.retry-recovery-note",
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
  "F6.skill-invocation",
  "F6.stripped-tool-call-placeholder",
  "F6.synthetic-developer-prompt",
  "F6.tool-result-image",
  "F6.toolresult-message-attached",
  "F6.user-prompt",
] as const;

describe("U1 message descriptors", () => {
  test("every descriptor is a C0 MessageDescriptor with one normalized role", () => {
    expect(U1MessageDescriptors).toHaveLength(8);
    for (const descriptor of U1MessageDescriptors) {
      expect(MessageDescriptor.safeParse(descriptor).success).toBe(true);
      expect(descriptor.owner).toBe("U1");
      expect(descriptor.match.by).toBe("role");
    }
    expect(Object.keys(U1MessageDescriptorByRole)).toEqual([
      "user",
      "developer",
      "assistant",
      "custom",
      "hookMessage",
      "fileMention",
      "toolResult",
      "session-entry",
    ]);
  });

  test("covers each of U1's 29 F6 rows exactly once", () => {
    const covers = U1MessageDescriptors.flatMap((descriptor) => descriptor.covers);
    expect(covers).toHaveLength(EXPECTED_F6_IDS.length);
    expect(new Set(covers).size).toBe(EXPECTED_F6_IDS.length);
    expect([...covers].sort()).toEqual([...EXPECTED_F6_IDS].sort());
  });
});
