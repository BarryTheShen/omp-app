import { P3ThreadHandoff, type P3ThreadHandoffOptions } from "./handoff";
import { createP3RunStatus, type P3RunStatus } from "./status";

/** Run state one composition shares across chats: a run switches chats, so it cannot live in one chat. */
export interface P3Runs {
  readonly handoff: P3ThreadHandoff;
  readonly status: P3RunStatus;
}

export function createP3Runs(options: P3ThreadHandoffOptions = {}): P3Runs {
  return { handoff: new P3ThreadHandoff(options), status: createP3RunStatus() };
}
