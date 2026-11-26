import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  AppFailure,
  MAX_FILE_CHUNK_BYTES,
  type SpeechPiece,
  SpeechPieceState,
  type SpeechPutPieceArgs,
  type SpeechRecording,
  type SpeechTestResult,
} from "@omp-app/contracts";
import { z } from "zod";
import type { Logger } from "../../../logging";
import type { ProcessTimer } from "../../../process/omp-process";
import { resolveAppDataDir, writeFileAtomic } from "../fs";
import type { SpeechSettingsStore } from "./settings";
import { joinPieceTexts, languageAllowed, silentWav, transcribe } from "./transcribe";
import { MIN_SPEECH_MS, speechMs } from "./vad";

/** Each server gets this many tries for a piece, these waits apart, before the next server (or the piece fails). */
const TRIES = 3;
const WAITS_MS = [2_000, 8_000] as const;
/** A server that has not answered for a piece in this long is given up on for that try. */
const TIMEOUT_MS = 60_000;
/** Pieces being transcribed at once, across recordings (one at a time within a recording, in order). */
const AT_ONCE = 2;
const DAY_MS = 86_400_000;
/** 16 kHz mono 16-bit: bytes per millisecond. */
const BYTES_PER_MS = 32;
const WAV_HEADER = 44;

const SavedPiece = z.object({
  state: SpeechPieceState,
  ms: z.int().nonnegative(),
  size: z.int().nonnegative(),
  text: z.string().optional(),
  error: z.string().optional(),
  server: z.string().optional(),
});
type SavedPiece = z.infer<typeof SavedPiece>;

const Saved = z.object({
  version: z.literal(1),
  id: z.string(),
  startedAt: z.int().nonnegative(),
  pieceCount: z.int().nonnegative().optional(),
  pieces: z.record(z.string(), SavedPiece),
});
type Saved = z.infer<typeof Saved>;

export interface SpeechRecordingsOptions {
  readonly settings: SpeechSettingsStore;
  readonly appDataDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
  readonly timer?: ProcessTimer;
  readonly now?: () => number;
  readonly logger?: Logger;
  /** How many ms of a piece are a human voice (the speech detector; tests give their own). */
  readonly speechMs?: (wav: Uint8Array) => Promise<number>;
}

export type SpeechRecordingsListener =
  | { readonly kind: "recording"; readonly recording: SpeechRecording }
  | { readonly kind: "removed"; readonly recordingId: string };

const SYSTEM_TIMER: ProcessTimer = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function notFound(what: string): AppFailure {
  return new AppFailure({ code: "not_found", message: `${what} was not found.`, retryable: false });
}

function errorText(error: unknown): string {
  if (error instanceof Error)
    return error.name === "AbortError" ? "No answer in 60 s." : error.message;
  return String(error);
}

/**
 * Voice input's recordings (`<app data>/voice/<id>/`, V259). A page sends each piece of a recording as it is cut, in
 * chunks; a complete piece is kept as `<index>.wav` and queued to be transcribed. The queue keeps a recording's pieces
 * in order, tries each server in turn with waits between tries, and keeps a piece that every server failed as `failed`
 * with its audio, for Retry. After a restart, pieces not yet transcribed go back into the queue. Recordings older than
 * the kept days are swept, audio and text.
 */
export class SpeechRecordings {
  readonly dir: string;
  readonly #settings: SpeechSettingsStore;
  readonly #fetch: typeof fetch;
  readonly #timer: ProcessTimer;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  readonly #speechMs: (wav: Uint8Array) => Promise<number>;
  readonly #listeners = new Set<(change: SpeechRecordingsListener) => void>();
  /** Per recording, the chain its file changes wait on, so two changes never interleave. */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Pieces waiting to be transcribed, in the order they came. */
  #waiting: { readonly recordingId: string; readonly index: number }[] = [];
  /** Recordings with a piece being transcribed now. */
  readonly #busy = new Set<string>();
  #sweepHandle: unknown;
  #stopped = false;
  /** The last sweep asked for: the next one runs after it, with its own day, so two never discard the same recording. */
  #sweeps: Promise<void> = Promise.resolve();

  constructor(options: SpeechRecordingsOptions) {
    this.dir = join(options.appDataDir ?? resolveAppDataDir(options), "voice");
    this.#settings = options.settings;
    this.#fetch = options.fetch ?? fetch;
    this.#timer = options.timer ?? SYSTEM_TIMER;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
    this.#speechMs = options.speechMs ?? speechMs;
  }

  /** Puts back in the queue what a restart left untranscribed, and sweeps old recordings now and daily. */
  async start(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.sweep();
    for (const saved of await this.#all()) {
      const indices = Object.keys(saved.pieces)
        .map(Number)
        .sort((a, b) => a - b);
      for (const index of indices) {
        const piece = saved.pieces[String(index)];
        if (piece?.state === "stored" || piece?.state === "transcribing")
          this.#waiting.push({ recordingId: saved.id, index });
      }
    }
    this.#pump();
    const daily = () => {
      if (this.#stopped) return;
      void this.sweep().catch(() => undefined);
      this.#sweepHandle = this.#timer.setTimeout(daily, DAY_MS);
    };
    this.#sweepHandle = this.#timer.setTimeout(daily, DAY_MS);
  }

  stop(): void {
    this.#stopped = true;
    this.#timer.clearTimeout(this.#sweepHandle);
  }

  subscribe(listener: (change: SpeechRecordingsListener) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async putPiece(args: SpeechPutPieceArgs): Promise<{ received: number; complete: boolean }> {
    const bytes = Buffer.from(args.data, "base64");
    if (bytes.length > MAX_FILE_CHUNK_BYTES || args.offset + bytes.length > args.size) {
      throw new AppFailure({
        code: "invalid_args",
        message: "These bytes do not fit in the piece.",
        retryable: false,
      });
    }
    return this.#locked(args.recordingId, async () => {
      const saved = (await this.#read(args.recordingId)) ?? {
        version: 1 as const,
        id: args.recordingId,
        startedAt: args.startedAt,
        pieces: {},
      };
      const known = saved.pieces[String(args.index)];
      // A piece sent again (a page that reloaded before it heard the answer) changes nothing.
      if (known !== undefined) return { received: known.size, complete: true };
      await fs.mkdir(this.#folder(args.recordingId), { recursive: true, mode: 0o700 });
      const part = `${this.#wav(args.recordingId, args.index)}.part`;
      const handle = await fs.open(part, "a+");
      let received: number;
      try {
        const size = (await handle.stat()).size;
        // Bytes past what is here would leave a hole; the page sends from what `received` says.
        if (args.offset > size) return { received: size, complete: false };
        await handle.write(bytes, 0, bytes.length, args.offset);
        received = Math.max(size, args.offset + bytes.length);
      } finally {
        await handle.close();
      }
      if (received < args.size) return { received, complete: false };
      await fs.rename(part, this.#wav(args.recordingId, args.index));
      saved.pieces[String(args.index)] = {
        state: "stored",
        size: args.size,
        ms: Math.round((args.size - WAV_HEADER) / BYTES_PER_MS),
      };
      await this.#write(saved);
      this.#emit(saved);
      this.#waiting.push({ recordingId: args.recordingId, index: args.index });
      this.#pump();
      return { received, complete: true };
    });
  }

  async finish(recordingId: string, pieceCount: number): Promise<SpeechRecording> {
    return this.#locked(recordingId, async () => {
      const saved = (await this.#read(recordingId)) ?? {
        version: 1 as const,
        id: recordingId,
        startedAt: this.#now(),
        pieces: {},
      };
      saved.pieceCount = pieceCount;
      await this.#write(saved);
      await this.#writeWhole(saved);
      return this.#emit(saved);
    });
  }

  async retry(recordingId: string, index: number): Promise<SpeechRecording> {
    return this.#locked(recordingId, async () => {
      const saved = await this.#read(recordingId);
      const piece = saved?.pieces[String(index)];
      if (saved === undefined || piece === undefined) throw notFound("That piece");
      if (piece.state === "failed") {
        saved.pieces[String(index)] = { state: "stored", ms: piece.ms, size: piece.size };
        await this.#write(saved);
        this.#waiting.push({ recordingId, index });
        this.#pump();
      }
      return this.#emit(saved);
    });
  }

  async list(): Promise<readonly SpeechRecording[]> {
    return (await this.#all())
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((saved) => this.#view(saved));
  }

  /** A piece's audio, or (without `index`) the whole recording's `audio.wav`, from `offset`: one chunk at most. */
  async audio(
    recordingId: string,
    index: number | undefined,
    offset: number,
  ): Promise<{ data: string; size: number }> {
    let handle: FileHandle;
    try {
      handle = await fs.open(
        index === undefined
          ? join(this.#folder(recordingId), "audio.wav")
          : this.#wav(recordingId, index),
        "r",
      );
    } catch {
      throw notFound(
        index === undefined
          ? "That recording's audio (it is not complete yet)"
          : "That piece's audio",
      );
    }
    try {
      const size = (await handle.stat()).size;
      const length = Math.max(0, Math.min(MAX_FILE_CHUNK_BYTES, size - offset));
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return { data: buffer.toString("base64"), size };
    } finally {
      await handle.close();
    }
  }

  /** Removes a recording and its audio; said to the pages only when there was one (a second Delete says nothing). */
  async discard(recordingId: string): Promise<void> {
    const existed = await this.#locked(recordingId, async () => {
      this.#waiting = this.#waiting.filter((item) => item.recordingId !== recordingId);
      const folder = this.#folder(recordingId);
      const there = await fs.stat(folder).then(
        () => true,
        () => false,
      );
      await fs.rm(folder, { recursive: true, force: true });
      return there;
    });
    if (!existed) return;
    for (const listener of this.#listeners) listener({ kind: "removed", recordingId });
  }

  /**
   * Removes the recordings started more than the kept days ago, but not one with a part still waiting for its text
   * (it goes on the next day's sweep once it is in).
   */
  sweep(): Promise<void> {
    const run = this.#sweeps.then(() => this.#sweepOnce());
    this.#sweeps = run.catch(() => undefined);
    return run;
  }

  async #sweepOnce(): Promise<void> {
    const { keepDays } = await this.#settings.values();
    const before = this.#now() - keepDays * DAY_MS;
    for (const saved of await this.#all()) {
      if (saved.startedAt >= before) continue;
      const waiting = Object.values(saved.pieces).some(
        (piece) => piece.state === "stored" || piece.state === "transcribing",
      );
      if (waiting) continue;
      await this.discard(saved.id);
      this.#logger?.info("speech.swept", { recording: saved.id });
    }
  }

  /** Sends a second of silence to one saved server: a server that works answers, with no words. */
  async test(serverId: string): Promise<SpeechTestResult> {
    const server = (await this.#settings.servers()).find((each) => each.id === serverId);
    if (server === undefined) throw notFound("That transcription server");
    const { language, context } = await this.#settings.values();
    const started = this.#now();
    try {
      await this.#withTimeout((signal) =>
        transcribe({
          server,
          wav: silentWav(1000),
          language,
          context,
          signal,
          fetch: this.#fetch,
        }),
      );
      return { ok: true, ms: Math.max(0, this.#now() - started) };
    } catch (error) {
      return { ok: false, error: errorText(error), ms: Math.max(0, this.#now() - started) };
    }
  }

  #pump(): void {
    if (this.#stopped) return;
    while (this.#busy.size < AT_ONCE) {
      const at = this.#waiting.findIndex((item) => !this.#busy.has(item.recordingId));
      if (at === -1) return;
      const [item] = this.#waiting.splice(at, 1);
      if (item === undefined) return;
      this.#busy.add(item.recordingId);
      void this.#transcribePiece(item.recordingId, item.index)
        .catch((error) =>
          this.#logger?.error("speech.queue_failed", {
            recording: item.recordingId,
            piece: item.index,
            error: errorText(error),
          }),
        )
        .finally(() => {
          this.#busy.delete(item.recordingId);
          this.#pump();
        });
    }
  }

  async #transcribePiece(recordingId: string, index: number): Promise<void> {
    const marked = await this.#update(recordingId, index, (piece) =>
      piece.state === "done" ? undefined : { ...piece, state: "transcribing" },
    );
    if (!marked) return;
    let wav: Uint8Array;
    try {
      wav = await fs.readFile(this.#wav(recordingId, index));
    } catch {
      await this.#update(recordingId, index, (piece) => ({
        ...piece,
        state: "failed",
        error: "The piece's audio is missing.",
      }));
      return;
    }
    // A part with no voice in it is not sent: the model writes a sentence for silence, a tap or a dog. Its audio
    // stays with the recording.
    const voice = await this.#speechMs(wav);
    if (voice < MIN_SPEECH_MS) {
      await this.#update(recordingId, index, (piece) => ({
        state: "done",
        ms: piece.ms,
        size: piece.size,
        text: "",
      }));
      this.#logger?.info("speech.no_voice", {
        recording: recordingId,
        piece: index,
        voice_ms: voice,
      });
      return;
    }
    const servers = await this.#settings.servers();
    const { language, context } = await this.#settings.values();
    let lastError =
      "Voice input has no transcription server. Add one in Settings → App → Voice input.";
    for (const server of servers) {
      for (let attempt = 0; attempt < TRIES; attempt++) {
        if (this.#stopped) return;
        if (attempt > 0) await this.#sleep(WAITS_MS[attempt - 1] ?? 8_000);
        const started = this.#now();
        try {
          const heard = await this.#withTimeout((signal) =>
            transcribe({ server, wav, language, context, signal, fetch: this.#fetch }),
          );
          // Text in a language the setting does not take is a guess at sounds (a sigh came back as Portuguese).
          const kept = languageAllowed(language, heard.language) && !heard.looped;
          const text = kept ? heard.text : "";
          await this.#update(recordingId, index, (piece) => ({
            state: "done",
            ms: piece.ms,
            size: piece.size,
            text,
            server: server.name,
          }));
          if (!kept)
            this.#logger?.info("speech.left_out", {
              recording: recordingId,
              piece: index,
              language: heard.language ?? "",
              looped: heard.looped,
            });
          this.#logger?.info("speech.transcribed", {
            recording: recordingId,
            piece: index,
            server: server.name,
            ms: this.#now() - started,
            chars: text.length,
          });
          return;
        } catch (error) {
          lastError = `${server.name}: ${errorText(error)}`;
          this.#logger?.warn("speech.try_failed", {
            recording: recordingId,
            piece: index,
            server: server.name,
            attempt: attempt + 1,
            error: errorText(error),
          });
          await this.#update(recordingId, index, (piece) => ({ ...piece, error: lastError }));
        }
      }
    }
    await this.#update(recordingId, index, (piece) => ({
      ...piece,
      state: "failed",
      error: lastError,
    }));
  }

  /** Changes one piece and tells the pages; `undefined` from `change` leaves it. False when the piece is gone. */
  async #update(
    recordingId: string,
    index: number,
    change: (piece: SavedPiece) => SavedPiece | undefined,
  ): Promise<boolean> {
    return this.#locked(recordingId, async () => {
      const saved = await this.#read(recordingId);
      const piece = saved?.pieces[String(index)];
      if (saved === undefined || piece === undefined) return false;
      const next = change(piece);
      if (next === undefined) return false;
      saved.pieces[String(index)] = next;
      await this.#write(saved);
      this.#emit(saved);
      await this.#writeWhole(saved);
      return true;
    });
  }

  /**
   * Once every piece of a recording is in, transcribed or failed: the whole recording as one `audio.wav` and its text as
   * `transcript.md`, beside the pieces, so an agent can find and use them (`<app data>/voice/<id>/`). Written again
   * when a retried piece gets its text.
   */
  async #writeWhole(saved: Saved): Promise<void> {
    const indices = Object.keys(saved.pieces)
      .map(Number)
      .sort((a, b) => a - b);
    if (saved.pieceCount === undefined || indices.length < saved.pieceCount) return;
    const pieces = indices.map((index) => saved.pieces[String(index)]);
    if (pieces.some((piece) => piece?.state !== "done" && piece?.state !== "failed")) return;
    const folder = this.#folder(saved.id);
    const datas: Buffer[] = [];
    for (const index of indices) {
      const wav = await fs.readFile(this.#wav(saved.id, index)).catch(() => null);
      if (wav !== null && wav.length > WAV_HEADER) datas.push(wav.subarray(WAV_HEADER));
    }
    const data = Buffer.concat(datas);
    const whole = Buffer.concat([Buffer.from(silentWav(0).subarray(0, WAV_HEADER)), data]);
    whole.writeUInt32LE(36 + data.length, 4);
    whole.writeUInt32LE(data.length, 40);
    await writeFileAtomic(join(folder, "audio.wav"), whole);
    const recording = this.#view(saved);
    const seconds = Math.round(recording.pieces.reduce((sum, piece) => sum + piece.ms, 0) / 1000);
    const failed = recording.pieces.filter((piece) => piece.state === "failed");
    const lines = [
      `# Voice recording ${saved.id}`,
      "",
      `- Started: ${new Date(saved.startedAt).toISOString()}`,
      `- Length: ${seconds} s, in ${recording.pieces.length} parts`,
      "- Audio: audio.wav in this folder (16 kHz mono 16-bit); each part as <n>.wav",
      ...(failed.length === 0
        ? []
        : [
            `- Not transcribed: part${failed.length === 1 ? "" : "s"} ${failed.map((piece) => piece.index).join(", ")}`,
          ]),
      "",
      recording.text,
      "",
    ];
    await writeFileAtomic(join(folder, "transcript.md"), lines.join("\n"));
  }

  #withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const handle = this.#timer.setTimeout(() => controller.abort(), TIMEOUT_MS);
    return run(controller.signal).finally(() => this.#timer.clearTimeout(handle));
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.#timer.setTimeout(resolve, ms));
  }

  #locked<T>(recordingId: string, work: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(recordingId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.catch(() => undefined);
    this.#locks.set(recordingId, settled);
    void settled.then(() => {
      if (this.#locks.get(recordingId) === settled) this.#locks.delete(recordingId);
    });
    return run;
  }

  #folder(recordingId: string): string {
    return join(this.dir, recordingId);
  }

  #wav(recordingId: string, index: number): string {
    return join(this.#folder(recordingId), `${index}.wav`);
  }

  async #read(recordingId: string): Promise<Saved | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(join(this.#folder(recordingId), "recording.json"), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = Saved.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async #write(saved: Saved): Promise<void> {
    await writeFileAtomic(
      join(this.#folder(saved.id), "recording.json"),
      `${JSON.stringify(saved)}\n`,
    );
  }

  async #all(): Promise<Saved[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const all: Saved[] = [];
    for (const name of names) {
      const saved = await this.#read(name);
      if (saved !== undefined) all.push(saved);
    }
    return all;
  }

  #view(saved: Saved): SpeechRecording {
    const pieces: SpeechPiece[] = Object.entries(saved.pieces)
      .map(([index, piece]) => ({
        index: Number(index),
        state: piece.state,
        ms: piece.ms,
        ...(piece.text === undefined ? {} : { text: piece.text }),
        ...(piece.error === undefined ? {} : { error: piece.error }),
        ...(piece.server === undefined ? {} : { server: piece.server }),
      }))
      .sort((a, b) => a.index - b.index);
    return {
      id: saved.id,
      startedAt: saved.startedAt,
      ...(saved.pieceCount === undefined ? {} : { pieceCount: saved.pieceCount }),
      pieces,
      text: joinPieceTexts(
        pieces.map((piece) => (piece.state === "done" ? (piece.text ?? "") : "")),
      ),
    };
  }

  #emit(saved: Saved): SpeechRecording {
    const recording = this.#view(saved);
    for (const listener of this.#listeners) {
      try {
        listener({ kind: "recording", recording });
      } catch {
        // A listener that throws must not stop the queue.
      }
    }
    return recording;
  }
}
