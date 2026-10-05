import { describe, expect, test } from "vitest";
import {
  COLLABORATION_CAPABILITY,
  COLLABORATION_UNAVAILABLE_REASON,
  CollaborationCommandSchema,
  CollaborationEventSchema,
  CollaborationStatusResultSchema,
  createUnavailableCollaborationPort,
  ParticipantStateSchema,
  ReadOnlySessionSnapshotSchema,
} from "../../contract";

describe("I4 collaboration contract", () => {
  test("validates the proposed AP6 command model", () => {
    expect(
      CollaborationCommandSchema.safeParse({
        type: "collab_start",
        mode: "host",
        displayName: "Alice",
      }).success,
    ).toBe(true);
    expect(
      CollaborationCommandSchema.safeParse({ type: "collab_join", link: "join-link" }).success,
    ).toBe(true);
    expect(CollaborationCommandSchema.safeParse({ type: "collab_stop", extra: true }).success).toBe(
      false,
    );
  });

  test("validates participant, status and event boundaries", () => {
    const participant = {
      id: "participant-1",
      displayName: "Alice",
      role: "host",
      presence: "active",
      readOnly: false,
    } as const;
    expect(ParticipantStateSchema.safeParse(participant).success).toBe(true);
    expect(
      CollaborationStatusResultSchema.safeParse({
        role: "host",
        participants: [participant],
        readOnly: false,
      }).success,
    ).toBe(true);
    expect(
      CollaborationEventSchema.safeParse({
        type: "collab_participant",
        participant,
      }).success,
    ).toBe(true);
    expect(
      CollaborationEventSchema.safeParse({
        type: "collab_guest_prompt",
        prompt: {
          sessionId: "session-1",
          participantId: "participant-1",
          messageId: "message-1",
          text: "hello",
          timestamp: 1_759_600_000_000,
        },
      }).success,
    ).toBe(true);
  });

  test("returns a read-only unavailable port without an app relay", async () => {
    const port = createUnavailableCollaborationPort();
    const results = await Promise.all([
      port.createView(),
      port.join("join-link"),
      port.leave(),
      port.stop(),
      port.status(),
    ]);

    for (const result of results) {
      expect(result.state).toBe("unavailable");
      if (result.state === "unavailable") {
        expect(result.error.code).toBe("unavailable");
        expect(result.error.capability).toBe(COLLABORATION_CAPABILITY);
        expect(result.error.message).toBe(COLLABORATION_UNAVAILABLE_REASON);
      }
    }
    expect(
      ReadOnlySessionSnapshotSchema.safeParse(port.readOnlySession.getSnapshot()).success,
    ).toBe(true);
    expect(port.readOnlySession.getSnapshot()).toMatchObject({
      phase: "unavailable",
      readOnly: true,
      unavailableReason: COLLABORATION_UNAVAILABLE_REASON,
    });
  });
});
