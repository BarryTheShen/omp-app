/**
 * The limits of the file reads one budget runs at once. A read holds a line of its file in memory while it parses it, so the
 * limit counts bytes: the bytes of files in flight, the number of files above `largeBytes`, and the number of files open
 * (a guard on file handles). A file larger than the byte limit runs alone.
 */
export interface ReadLimits {
  /** Bytes of files in flight at once. */
  readonly bytes: number;
  /** A file above this many bytes is large. */
  readonly largeBytes: number;
  /** Large files in flight at once. */
  readonly largeFiles: number;
  /** Files open at once. */
  readonly files: number;
}

const MiB = 1024 * 1024;

/**
 * The reads of a listing: the page a person is waiting for. One file above 16 MiB at a time: a file's lines are parsed
 * whole. With two such files in flight, a first page's cold resident memory was 132 to 152 MiB on the test machine (the bound is 150).
 */
export const LISTING_READ_LIMITS: ReadLimits = {
  bytes: 64 * MiB,
  largeBytes: 16 * MiB,
  largeFiles: 1,
  files: 24,
};

/**
 * The reads that refresh chats already shown: a small budget of their own, so that a refresh of a large chat never holds up
 * a listing. One large file at a time, and never more than four files open.
 */
export const REFRESH_READ_LIMITS: ReadLimits = {
  bytes: 16 * MiB,
  largeBytes: 16 * MiB,
  largeFiles: 1,
  files: 4,
};

interface WaitingRead {
  readonly bytes: number;
  readonly large: boolean;
  readonly admit: () => void;
}

/** Starts file reads only while they fit in its limits. Waiting reads start in the order they came. */
export class ReadBudget {
  readonly #limits: ReadLimits;
  readonly #waiting: WaitingRead[] = [];
  #files = 0;
  #bytes = 0;
  #large = 0;

  constructor(limits: ReadLimits = LISTING_READ_LIMITS) {
    this.#limits = limits;
  }

  /** Resolves with `read`'s result once `bytes` fit in the limits; the room is given back when `read` settles. */
  async run<T>(bytes: number, read: () => Promise<T>): Promise<T> {
    const cost = Math.min(Math.max(0, bytes), this.#limits.bytes);
    const large = cost > this.#limits.largeBytes;
    await new Promise<void>((resolve) => {
      this.#waiting.push({ bytes: cost, large, admit: () => resolve() });
      this.#admit();
    });
    try {
      return await read();
    } finally {
      this.#files -= 1;
      this.#bytes -= cost;
      if (large) this.#large -= 1;
      this.#admit();
    }
  }

  /** Starts waiting reads in order; a read that does not fit holds back the ones behind it. */
  #admit(): void {
    for (;;) {
      const next = this.#waiting[0];
      if (next === undefined || !this.#fits(next)) return;
      this.#waiting.shift();
      this.#files += 1;
      this.#bytes += next.bytes;
      if (next.large) this.#large += 1;
      next.admit();
    }
  }

  #fits(next: WaitingRead): boolean {
    if (this.#files >= this.#limits.files) return false;
    if (next.bytes > 0 && this.#bytes > 0 && this.#bytes + next.bytes > this.#limits.bytes) {
      return false;
    }
    return !next.large || this.#large < this.#limits.largeFiles;
  }
}
