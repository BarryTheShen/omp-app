/** R0's recorded chat sessions (`recordings/`, see `recorded-session.ts`), parsed. */

import { parseRecording } from "./recorded-session";
import abortText from "./recordings/abort.session.jsonl?raw";
import promptStreamText from "./recordings/prompt-stream.session.jsonl?raw";
import uiRoundTripText from "./recordings/ui-round-trip.session.jsonl?raw";

/** A prompt (`run_bash`) answered with reasoning, a bash tool call and text, then settled. */
export const PROMPT_STREAM = parseRecording(promptStreamText);
/** A prompt (`abort_slow`) aborted while the assistant streams. */
export const ABORT = parseRecording(abortText);
/** The rich ask dialog switched on, then a prompt (`ask_user`) whose ask the browser answers ("SQLite"). */
export const UI_ROUND_TRIP = parseRecording(uiRoundTripText);
