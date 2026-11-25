import { z } from "zod";
import { definePort } from "../../core/envelope";
import { Revision } from "./shared";
import { FileChunkBytes } from "./workspace-files";

/**
 * Voice input (V259): a recording made in a page goes to this server in pieces, and the server has each piece written
 * out by a transcription server the user runs (the app ships no model). A piece's audio is kept until its text is in,
 * and a failed piece keeps its audio for Retry, so nothing said is lost to a transcription that failed.
 */

/** A server's or a recording's id: letters, digits, `-` and `_` (a recording's is made by the page, a UUID). */
export const SpeechId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type SpeechId = z.infer<typeof SpeechId>;

/**
 * How a transcription server is spoken to. `transcriptions`: the OpenAI transcription API, `POST <url>/audio/
 * transcriptions` with the audio as a form file (vLLM, OpenAI, Groq). `chat-audio`: the OpenAI chat API with the audio
 * as an `input_audio` part, `POST <url>/chat/completions` (llama.cpp's `llama-server`).
 */
export const SpeechServerApi = z.enum(["transcriptions", "chat-audio"]);
export type SpeechServerApi = z.infer<typeof SpeechServerApi>;

/** A transcription server, as the pages see it: its key, when it has one, never leaves this server. */
export const SpeechServer = z.strictObject({
  id: SpeechId,
  name: z.string().min(1).max(64),
  /** The API's base, up to and including `/v1` (`http://gpu-box:8080/v1`). */
  url: z.url({ protocol: /^https?$/ }).max(512),
  api: SpeechServerApi,
  /** The model the server is asked for; some servers ignore it. */
  model: z.string().max(128),
  hasKey: z.boolean(),
});
export type SpeechServer = z.infer<typeof SpeechServer>;

export const SpeechLanguage = z.enum(["auto", "zh", "en"]);
export type SpeechLanguage = z.infer<typeof SpeechLanguage>;

export const SpeechSettings = z.strictObject({
  enabled: z.boolean(),
  /** Tried in order: the first is used, the next ones when the one before fails. */
  servers: z.array(SpeechServer).max(4),
  /** `auto` lets the server tell (mixed Chinese and English stays as spoken). */
  language: SpeechLanguage,
  /** Names and words to recognise (people, projects, jargon), given to the server as context. */
  context: z.string().max(2000),
  /** Days a recording, its audio and its text are kept. */
  keepDays: z.int().min(1).max(365),
});
export type SpeechSettings = z.infer<typeof SpeechSettings>;

export const SpeechSettingsRead = z.strictObject({ settings: SpeechSettings, revision: Revision });
export type SpeechSettingsRead = z.infer<typeof SpeechSettingsRead>;

/** A server as a change sends it: `key` left out keeps the one kept, `null` removes it. */
export const SpeechServerInput = SpeechServer.omit({ hasKey: true }).extend({
  key: z.string().min(1).max(512).nullable().optional(),
});
export type SpeechServerInput = z.infer<typeof SpeechServerInput>;

export const SpeechSettingsSetArgs = z.strictObject({
  settings: SpeechSettings.omit({ servers: true }).extend({
    servers: z.array(SpeechServerInput).max(4),
  }),
  /** The revision the caller read; a change since is a retryable `conflict`. */
  expectedRevision: Revision,
});
export type SpeechSettingsSetArgs = z.infer<typeof SpeechSettingsSetArgs>;

export const SpeechTestResult = z.strictObject({
  ok: z.boolean(),
  /** What went wrong, in words, when it failed. */
  error: z.string().max(2000).optional(),
  ms: z.int().nonnegative(),
});
export type SpeechTestResult = z.infer<typeof SpeechTestResult>;

/** At most this many pieces in a recording (30 s each: over 8 hours). */
export const MAX_SPEECH_PIECES = 1000;
/** A piece is at most this long: 16 kHz mono 16-bit WAV of 60 s and its header. */
export const MAX_SPEECH_PIECE_BYTES = 60 * 16000 * 2 + 44;

export const SpeechPieceState = z.enum(["stored", "transcribing", "done", "failed"]);
export type SpeechPieceState = z.infer<typeof SpeechPieceState>;

export const SpeechPiece = z.strictObject({
  index: z
    .int()
    .min(0)
    .max(MAX_SPEECH_PIECES - 1),
  state: SpeechPieceState,
  ms: z.int().nonnegative(),
  text: z.string().optional(),
  /** Why the last try failed (shown while it is retried, and when it gave up). */
  error: z.string().max(2000).optional(),
  /** The server that wrote the text. */
  server: z.string().max(64).optional(),
});
export type SpeechPiece = z.infer<typeof SpeechPiece>;

export const SpeechRecording = z.strictObject({
  id: SpeechId,
  startedAt: z.int().nonnegative(),
  /** How many pieces the recording has, once its page said it stopped. */
  pieceCount: z.int().min(0).max(MAX_SPEECH_PIECES).optional(),
  pieces: z.array(SpeechPiece),
  /** Every piece's text so far, in order, joined. */
  text: z.string(),
});
export type SpeechRecording = z.infer<typeof SpeechRecording>;

export const SpeechPutPieceArgs = z.strictObject({
  recordingId: SpeechId,
  /** When the recording started, as the page saw it (its first piece makes the recording). */
  startedAt: z.int().nonnegative(),
  index: z
    .int()
    .min(0)
    .max(MAX_SPEECH_PIECES - 1),
  /** Where these bytes go in the piece's WAV file. */
  offset: z.int().min(0).max(MAX_SPEECH_PIECE_BYTES),
  data: FileChunkBytes,
  /** The piece's whole length: with these bytes it is complete, and goes to be transcribed. */
  size: z.int().min(44).max(MAX_SPEECH_PIECE_BYTES),
});
export type SpeechPutPieceArgs = z.infer<typeof SpeechPutPieceArgs>;

const RecordingArgs = z.strictObject({ recordingId: SpeechId });
const PieceArgs = z.strictObject({
  recordingId: SpeechId,
  index: z
    .int()
    .min(0)
    .max(MAX_SPEECH_PIECES - 1),
});

const CAPABILITY = "host.speech-to-text";

export const SpeechToTextPort = definePort({
  name: "A1.speechToText",
  methods: {
    settings: { args: z.strictObject({}), result: SpeechSettingsRead, capability: CAPABILITY },
    setSettings: {
      args: SpeechSettingsSetArgs,
      result: SpeechSettingsRead,
      capability: CAPABILITY,
    },
    /** Sends a second of silence to a saved server: it works when it answers with text (likely empty). */
    test: {
      args: z.strictObject({ serverId: SpeechId }),
      result: SpeechTestResult,
      capability: CAPABILITY,
    },
    /** Some of a piece's bytes; sending a piece again (after a reload) is harmless. */
    putPiece: {
      args: SpeechPutPieceArgs,
      result: z.strictObject({ received: z.int().nonnegative(), complete: z.boolean() }),
      capability: CAPABILITY,
    },
    /** The page stopped: the recording has this many pieces. */
    finish: {
      args: RecordingArgs.extend({ pieceCount: z.int().min(0).max(MAX_SPEECH_PIECES) }),
      result: SpeechRecording,
      capability: CAPABILITY,
    },
    /** Sends a failed piece to be transcribed again, from the first server. */
    retry: { args: PieceArgs, result: SpeechRecording, capability: CAPABILITY },
    /** The kept recordings, newest first. */
    list: {
      args: z.strictObject({}),
      result: z.strictObject({ recordings: z.array(SpeechRecording) }),
      capability: CAPABILITY,
    },
    /**
     * Audio for Play and Attach: a piece's WAV bytes from `offset`, at most one chunk; without `index`, the whole
     * recording's (`audio.wav`, written once every piece is in).
     */
    audio: {
      args: z.strictObject({
        recordingId: SpeechId,
        index: z
          .int()
          .min(0)
          .max(MAX_SPEECH_PIECES - 1)
          .optional(),
        offset: z
          .int()
          .min(0)
          .max(MAX_SPEECH_PIECES * MAX_SPEECH_PIECE_BYTES),
      }),
      result: z.strictObject({ data: FileChunkBytes, size: z.int().nonnegative() }),
      capability: CAPABILITY,
    },
    discard: { args: RecordingArgs, result: z.strictObject({}), capability: CAPABILITY },
  },
  events: {
    /** The settings after a change from any page. */
    settingsChanged: { payload: SpeechSettingsRead, capability: CAPABILITY },
    /** A recording after any change: a piece stored, transcribed, failed or retried. */
    recording: { payload: SpeechRecording, capability: CAPABILITY },
    /** A recording was discarded or swept. */
    removed: { payload: RecordingArgs, capability: CAPABILITY },
  },
});
