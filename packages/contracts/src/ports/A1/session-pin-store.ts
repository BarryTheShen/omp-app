import { z } from "zod";
import { definePort } from "../../core/envelope";
import { ThreadId } from "../../core/ids";
import { Revision, Timestamp } from "./shared";

/** Global omp pins are keyed by session id and survive session-file moves. */
export const SessionPin = z.strictObject({
  sessionId: ThreadId,
  pinned: z.literal(true),
  /** Kept optional for forward-compatible pin formats; v18.6.1 stores only ids. */
  account: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
});
export type SessionPin = z.infer<typeof SessionPin>;

export const SessionPinListResult = z.strictObject({
  pins: z.array(SessionPin),
  revision: Revision,
  readAt: Timestamp,
});
export type SessionPinListResult = z.infer<typeof SessionPinListResult>;

export const SessionPinSetArgs = z.strictObject({
  sessionId: ThreadId,
  pinned: z.boolean(),
  /** `null` means the caller expects an absent pins file. */
  expectedRevision: Revision.nullable(),
});
export type SessionPinSetArgs = z.infer<typeof SessionPinSetArgs>;

export const SessionPinSetResult = z.strictObject({
  sessionId: ThreadId,
  pinned: z.boolean(),
  revision: Revision,
});
export type SessionPinSetResult = z.infer<typeof SessionPinSetResult>;

export const SessionPinChanged = z.strictObject({
  sessionId: ThreadId,
  pinned: z.boolean(),
  revision: Revision,
});
export type SessionPinChanged = z.infer<typeof SessionPinChanged>;

export const SessionPinStore = definePort({
  name: "A1.sessionPinStore",
  methods: {
    list: {
      args: z.strictObject({}),
      result: SessionPinListResult,
      capability: "host.session-pins",
    },
    set: {
      args: SessionPinSetArgs,
      result: SessionPinSetResult,
      capability: "host.session-pins",
    },
  },
  events: {
    changed: {
      payload: SessionPinChanged,
      capability: "host.session-pins",
    },
  },
});
