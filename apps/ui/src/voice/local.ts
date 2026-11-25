import type { AppClient } from "@omp-app/client";
import { MAX_FILE_CHUNK_BYTES, SpeechToTextPort } from "@omp-app/contracts";
import { createStore, del, entries, get, set } from "idb-keyval";
import { encodeWav } from "./wav";

/**
 * Voice input's pieces on this device (V259): every piece is written here before it is sent, and the piece in the
 * making every few seconds, so a reload, a crash or a dropped link loses nothing that was said. A piece leaves this
 * store once the server has all of it; a recording's record leaves once the server knows how many pieces it has.
 */
const store = createStore("omp-app-voice", "pieces");

interface LocalPiece {
  readonly recordingId: string;
  readonly startedAt: number;
  readonly index: number;
  readonly wav: Uint8Array;
}

interface LocalRecording {
  readonly id: string;
  readonly startedAt: number;
  /** Set when the recording ended (Done, Cancel, or found unfinished after a reload): how many pieces it has. */
  readonly pieceCount?: number;
  /** The pieces kept so far (sent ones are gone from here): where a recording found unfinished ends. */
  readonly kept?: number;
}

const pieceKey = (id: string, index: number) => `${id}/piece/${String(index).padStart(5, "0")}`;
const partialKey = (id: string) => `${id}/partial`;
const recordingKey = (id: string) => `${id}/recording`;

export async function beginRecording(id: string, startedAt: number): Promise<void> {
  await set(recordingKey(id), { id, startedAt } satisfies LocalRecording, store);
}

export async function keepPiece(
  id: string,
  startedAt: number,
  index: number,
  samples: Int16Array,
): Promise<void> {
  const piece: LocalPiece = { recordingId: id, startedAt, index, wav: encodeWav(samples) };
  await set(pieceKey(id, index), piece, store);
  await del(partialKey(id), store);
  await set(recordingKey(id), { id, startedAt, kept: index + 1 } satisfies LocalRecording, store);
}

/** The piece in the making as it is now; it becomes piece `index` if the page is gone before it is cut. */
export async function keepPartial(
  id: string,
  startedAt: number,
  index: number,
  samples: Int16Array,
): Promise<void> {
  if (samples.length === 0) return;
  const piece: LocalPiece = { recordingId: id, startedAt, index, wav: encodeWav(samples) };
  await set(partialKey(id), piece, store);
}

export async function endRecording(
  id: string,
  startedAt: number,
  pieceCount: number,
): Promise<void> {
  await del(partialKey(id), store);
  await set(recordingKey(id), { id, startedAt, pieceCount } satisfies LocalRecording, store);
}

/**
 * Ends the recordings a page left unfinished (it was reloaded, closed or crashed while recording), except the one
 * this page is making: the piece in the making becomes the last piece. Gives back the ids it ended.
 */
export async function recoverUnfinished(except: string | null): Promise<readonly string[]> {
  const all = await entries<string, LocalRecording | LocalPiece>(store);
  const recovered: string[] = [];
  for (const [key, value] of all) {
    if (!key.endsWith("/recording")) continue;
    const recording = value as LocalRecording;
    if (recording.pieceCount !== undefined || recording.id === except) continue;
    const partial = (await get<LocalPiece>(partialKey(recording.id), store)) ?? null;
    let count = recording.kept ?? 0;
    // The piece in the making, longer than 0.3 s, is the last piece.
    if (partial !== null && partial.wav.length > 44 + 32 * 300) {
      await set(pieceKey(recording.id, partial.index), partial, store);
      count = Math.max(count, partial.index + 1);
    }
    await endRecording(recording.id, recording.startedAt, count);
    recovered.push(recording.id);
  }
  return recovered;
}

/** Pieces still on this device, not yet all on the server. */
export async function unsentCount(id?: string): Promise<number> {
  const keys = (await entries<string, unknown>(store)).map(([key]) => key);
  return keys.filter(
    (key) => key.includes("/piece/") && (id === undefined || key.startsWith(`${id}/`)),
  ).length;
}

let draining: Promise<boolean> | null = null;

/**
 * Sends every piece this device still holds, oldest first, then tells the server how many pieces each ended
 * recording has. True when nothing is left; false when the link failed (the caller tries again later). One at a time:
 * a second call while one runs waits for it.
 */
export function drain(client: AppClient): Promise<boolean> {
  draining ??= drainOnce(client).finally(() => {
    draining = null;
  });
  return draining;
}

async function drainOnce(client: AppClient): Promise<boolean> {
  const port = client.port(SpeechToTextPort);
  const all = (await entries<string, LocalRecording | LocalPiece>(store)).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  try {
    for (const [key, value] of all) {
      if (!key.includes("/piece/")) continue;
      const piece = value as LocalPiece;
      let offset = 0;
      while (offset < piece.wav.length) {
        const chunk = piece.wav.subarray(offset, offset + MAX_FILE_CHUNK_BYTES);
        const result = await port.putPiece({
          recordingId: piece.recordingId,
          startedAt: piece.startedAt,
          index: piece.index,
          offset,
          data: base64(chunk),
          size: piece.wav.length,
        });
        if (result.complete) break;
        // The server says where its copy ends (a piece half sent before a reload): go on from there.
        offset = result.received > offset ? result.received : offset + chunk.length;
      }
      await del(key, store);
    }
    for (const [key, value] of all) {
      if (!key.endsWith("/recording")) continue;
      const recording = value as LocalRecording;
      if (recording.pieceCount === undefined) continue;
      const left = (await entries<string, unknown>(store)).some(([other]) =>
        other.startsWith(`${recording.id}/piece/`),
      );
      if (left) continue;
      await port.finish({ recordingId: recording.id, pieceCount: recording.pieceCount });
      await del(key, store);
    }
    return true;
  } catch {
    return false;
  }
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}
