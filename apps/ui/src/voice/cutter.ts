import { RATE } from "./wav";

/** A piece is cut at a pause once it is this long… */
export const MIN_PIECE_MS = 10_000;
/** …and in any case at this length, at the quietest moment of its last seconds. */
export const MAX_PIECE_MS = 30_000;
/** A pause is this long, at least. */
const PAUSE_MS = 400;
/** Loudness is judged over frames this long. */
const FRAME_MS = 30;
const FRAME = (RATE * FRAME_MS) / 1000;
/** Where a 30 s piece has no pause, it is cut at the quietest frame of its last this-many ms. */
const LOOK_BACK_MS = 5_000;

/** A frame's loudness, the root mean square of its samples (0 to 32767). */
function loudness(samples: Int16Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, end - start));
}

/**
 * Cuts the recording into pieces at pauses, so each piece holds whole words: once a piece is 10 s long, it ends in the
 * middle of the next pause of 400 ms or more; at 30 s it ends at its quietest moment of the last 5 s. A pause is quiet
 * against the room: a frame quieter than three times the quietest recent frames (and than a fixed floor for loud rooms).
 */
export class PieceCutter {
  #buffer = new Int16Array(RATE * 40);
  #length = 0;
  /**
   * The room's quiet: the quietest recent frame, rising slowly (about 1.5% a second) so a room that got louder (a fan)
   * becomes the new quiet. It starts at a quiet room's level: a recording that starts with speech must not take the
   * speech for the room.
   */
  #floor = 300;
  /** The frames of the current piece whose loudness is known. */
  #frames = 0;
  /** Where the current pause began (a frame index), or -1. */
  #pauseFrom = -1;
  #loud: number[] = [];

  /** How long the piece in the making is, in ms. */
  get pendingMs(): number {
    return Math.round((this.#length / RATE) * 1000);
  }

  /** Adds samples; gives back the pieces they completed (usually none, now and then one). */
  push(samples: Int16Array): Int16Array[] {
    this.#ensure(this.#length + samples.length);
    this.#buffer.set(samples, this.#length);
    this.#length += samples.length;
    const pieces: Int16Array[] = [];
    while ((this.#frames + 1) * FRAME <= this.#length) {
      const at = this.#frames;
      const level = loudness(this.#buffer, at * FRAME, (at + 1) * FRAME);
      this.#loud[at] = level;
      this.#floor = Math.min(this.#floor * 1.0005, Math.max(level, 30));
      this.#frames += 1;
      const quiet = level < Math.max(this.#floor * 3, 300);
      if (quiet) {
        if (this.#pauseFrom === -1) this.#pauseFrom = at;
      } else this.#pauseFrom = -1;
      const ms = (this.#frames * FRAME_MS) | 0;
      const pauseFrames = this.#pauseFrom === -1 ? 0 : this.#frames - this.#pauseFrom;
      if (ms >= MIN_PIECE_MS && pauseFrames * FRAME_MS >= PAUSE_MS) {
        pieces.push(this.#cutAt(this.#pauseFrom + Math.floor(pauseFrames / 2)));
      } else if (ms >= MAX_PIECE_MS) {
        const from = this.#frames - Math.floor(LOOK_BACK_MS / FRAME_MS);
        let quietest = this.#frames - 1;
        for (let frame = from; frame < this.#frames; frame++)
          if ((this.#loud[frame] ?? 0) < (this.#loud[quietest] ?? 0)) quietest = frame;
        pieces.push(this.#cutAt(quietest + 1));
      }
    }
    return pieces;
  }

  /** The piece in the making, ended now (Stop, or the microphone stopped); empty when there is none. */
  flush(): Int16Array {
    const piece = this.#buffer.slice(0, this.#length);
    this.#length = 0;
    this.#frames = 0;
    this.#pauseFrom = -1;
    this.#loud = [];
    return piece;
  }

  /** The piece in the making as it is now, without ending it: what is saved every few seconds. */
  peek(): Int16Array {
    return this.#buffer.slice(0, this.#length);
  }

  #cutAt(frame: number): Int16Array {
    const end = frame * FRAME;
    const piece = this.#buffer.slice(0, end);
    this.#buffer.copyWithin(0, end, this.#length);
    this.#length -= end;
    this.#loud = this.#loud.slice(frame);
    this.#frames -= frame;
    this.#pauseFrom = this.#pauseFrom === -1 ? -1 : Math.max(0, this.#pauseFrom - frame);
    // The rest of the pause is the new piece's start, not a pause that cuts it again.
    if (this.#pauseFrom !== -1) this.#pauseFrom = -1;
    return piece;
  }

  #ensure(size: number): void {
    if (size <= this.#buffer.length) return;
    const next = new Int16Array(Math.max(size, this.#buffer.length * 2));
    next.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = next;
  }
}
