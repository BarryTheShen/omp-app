/** Maximum UTF-8 size of one newline-delimited RPC frame, including its newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled by protocol v2. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Maximum decoded payload carried by one `rpc_chunk` frame. */
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
const MAX_CHUNK_ID_LENGTH = 128;

export interface FrameDecoderOptions {
  /** Maximum physical JSONL frame size, including the newline. */
  readonly maxFrameBytes?: number;
  /** Maximum logical frame size after v2 chunk reassembly. */
  readonly maxReassembledFrameBytes?: number;
}

export type FrameDecoderErrorCode =
  | "line_too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "not_object"
  | "ready_limits"
  | "chunk_metadata"
  | "chunk_data"
  | "chunk_payload_too_large"
  | "chunk_sequence"
  | "chunk_length"
  | "reassembled_invalid_utf8"
  | "reassembled_invalid_json"
  | "reassembled_not_object"
  | "truncated_line";

/** A recoverable local transport/decode failure; it is distinct from omp's `rpc_frame_error`. */
export interface FrameDecodeError {
  readonly type: "decode_error";
  readonly code: FrameDecoderErrorCode;
  readonly message: string;
  readonly byteLength: number;
  readonly lineNumber: number;
  readonly recoverable: true;
  readonly originalType?: string;
}

export interface DecodedFrameEvent {
  readonly type: "frame";
  readonly frame: Record<string, unknown>;
}

export type FrameDecoderEvent = DecodedFrameEvent | FrameDecodeError;

interface PendingChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly chunks: Uint8Array[];
  nextIndex: number;
  receivedBytes: number;
}

interface Utf8DecodeResult {
  readonly ok: true;
  readonly text: string;
}

interface Utf8DecodeFailure {
  readonly ok: false;
}

type Utf8Result = Utf8DecodeResult | Utf8DecodeFailure;

export type FrameDecoderInput = Uint8Array | ArrayBuffer | string;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) index++;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function toBytes(input: FrameDecoderInput): Uint8Array {
  if (typeof input === "string") return encodeUtf8(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("FrameDecoder input must be UTF-8 bytes or a string");
}

/** Decode UTF-8 without replacement characters. */
function decodeUtf8Strict(bytes: Uint8Array): Utf8Result {
  const output: string[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const first = bytes[index];
    if (first === undefined) return { ok: false };
    if (first <= 0x7f) {
      output.push(String.fromCharCode(first));
      continue;
    }

    let codePoint: number;
    let continuationCount: number;
    if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      continuationCount = 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      continuationCount = 2;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      continuationCount = 3;
    } else {
      return { ok: false };
    }

    if (index + continuationCount >= bytes.length) return { ok: false };
    const second = bytes[index + 1];
    if (second === undefined || (second & 0xc0) !== 0x80) return { ok: false };
    if (first === 0xe0 && second < 0xa0) return { ok: false };
    if (first === 0xed && second >= 0xa0) return { ok: false };
    if (first === 0xf0 && second < 0x90) return { ok: false };
    if (first === 0xf4 && second > 0x8f) return { ok: false };

    codePoint = (codePoint << 6) | (second & 0x3f);
    for (let offset = 2; offset <= continuationCount; offset++) {
      const continuation = bytes[index + offset];
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) return { ok: false };
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    output.push(String.fromCodePoint(codePoint));
    index += continuationCount;
  }
  return { ok: true, text: output.join("") };
}

function base64Value(value: string): number {
  return BASE64_ALPHABET.indexOf(value);
}

function decodeBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return undefined;

  const firstPadding = value.indexOf("=");
  const padding = firstPadding === -1 ? 0 : value.length - firstPadding;
  if (padding > 2 || (padding > 0 && firstPadding !== value.length - padding)) return undefined;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index++) {
    if (base64Value(value[index] ?? "") < 0) return undefined;
  }
  for (let index = dataLength; index < value.length; index++) {
    if (value[index] !== "=") return undefined;
  }
  if (padding === 1 && dataLength % 4 !== 3) return undefined;
  if (padding === 2 && dataLength % 4 !== 2) return undefined;
  if (padding === 0 && dataLength % 4 !== 0) return undefined;

  const outputLength = (value.length / 4) * 3 - padding;
  const output = new Uint8Array(outputLength);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = base64Value(value[index] ?? "");
    const second = base64Value(value[index + 1] ?? "");
    const third = value[index + 2] === "=" ? 0 : base64Value(value[index + 2] ?? "");
    const fourth = value[index + 3] === "=" ? 0 : base64Value(value[index + 3] ?? "");
    if (first < 0 || second < 0 || third < 0 || fourth < 0) return undefined;
    if (value[index + 2] === "=" && (value[index + 3] !== "=" || (second & 0x0f) !== 0))
      return undefined;
    if (value[index + 3] === "=" && value[index + 2] !== "=" && (third & 0x03) !== 0)
      return undefined;

    const combined = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < output.length) output[outputIndex++] = (combined >> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (combined >> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = combined & 0xff;
  }
  return output;
}

function originalType(value: Record<string, unknown>): string | undefined {
  return typeof value.type === "string" ? value.type : undefined;
}

/**
 * Incremental decoder for omp's stdout JSONL transport.
 *
 * Input is consumed as bytes, so a UTF-8 code point may cross any number of input chunks. Every
 * malformed physical or logical frame becomes a recoverable `decode_error`; an error clears
 * the current chunk sequence and the next valid line can be decoded normally.
 */
export class FrameDecoder {
  #maxFrameBytes: number;
  #maxReassembledFrameBytes: number;
  #lineParts: Uint8Array[] = [];
  #lineLength = 0;
  #lineBytesSeen = 0;
  #discardLine = false;
  #lineNumber = 0;
  #currentLineByteLength = 0;
  #pending?: PendingChunks;

  constructor(options: FrameDecoderOptions = {}) {
    const maxFrameBytes = options.maxFrameBytes ?? MAX_RPC_FRAME_BYTES;
    const maxReassembledFrameBytes = options.maxReassembledFrameBytes ?? MAX_RPC_REASSEMBLED_BYTES;
    if (!validLimit(maxFrameBytes))
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    if (!validLimit(maxReassembledFrameBytes)) {
      throw new RangeError("maxReassembledFrameBytes must be a positive safe integer");
    }
    this.#maxFrameBytes = maxFrameBytes;
    this.#maxReassembledFrameBytes = maxReassembledFrameBytes;
  }

  get maxFrameBytes(): number {
    return this.#maxFrameBytes;
  }

  get maxReassembledFrameBytes(): number {
    return this.#maxReassembledFrameBytes;
  }

  /** Consume one arbitrary byte/string chunk and return all complete frame/error events. */
  push(input: FrameDecoderInput): FrameDecoderEvent[] {
    const bytes = toBytes(input);
    const events: FrameDecoderEvent[] = [];
    let segmentStart = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0x0a) continue;
      this.#appendLinePart(bytes.subarray(segmentStart, index));
      events.push(...this.#finishLine());
      segmentStart = index + 1;
    }
    this.#appendLinePart(bytes.subarray(segmentStart));
    return events;
  }

  /** Finish the stream, reporting a non-newline-terminated physical line as a decode error. */
  finish(): FrameDecoderEvent[] {
    if (this.#lineBytesSeen === 0 && !this.#discardLine) {
      if (this.#pending === undefined) return [];
      this.#pending = undefined;
      return [this.#decodeError("chunk_sequence", "RPC chunk sequence interrupted")];
    }
    this.#lineNumber++;
    const byteLength = this.#lineBytesSeen;
    const interrupted = this.#pending !== undefined;
    const wasTooLarge = this.#discardLine;
    this.#pending = undefined;
    this.#resetLine();
    this.#currentLineByteLength = byteLength;
    const events = wasTooLarge
      ? [this.#decodeError("line_too_large", "RPC frame exceeds the transport limit")]
      : [
          this.#decodeError(
            interrupted ? "chunk_sequence" : "truncated_line",
            interrupted ? "RPC chunk sequence interrupted" : "RPC line ended before a newline",
          ),
        ];
    this.#currentLineByteLength = 0;
    return events;
  }

  #appendLinePart(part: Uint8Array): void {
    if (part.length === 0) return;
    this.#lineBytesSeen += part.length;
    if (this.#discardLine) return;
    if (this.#lineBytesSeen + 1 > this.#maxFrameBytes) {
      this.#discardLine = true;
      this.#lineParts = [];
      this.#lineLength = 0;
      return;
    }
    this.#lineParts.push(part.slice());
    this.#lineLength += part.length;
  }

  #finishLine(): FrameDecoderEvent[] {
    this.#lineNumber++;
    const byteLength = this.#lineBytesSeen + 1;
    if (this.#discardLine) {
      this.#resetLine();
      this.#pending = undefined;
      this.#currentLineByteLength = byteLength;
      const event = this.#decodeError("line_too_large", "RPC frame exceeds the transport limit");
      this.#currentLineByteLength = 0;
      return [event];
    }

    const line = this.#joinLineParts();
    this.#resetLine();
    this.#currentLineByteLength = byteLength;
    const events = this.#decodeLine(line);
    this.#currentLineByteLength = 0;
    return events;
  }

  #joinLineParts(): Uint8Array {
    if (this.#lineParts.length === 0) return new Uint8Array(0);
    if (this.#lineParts.length === 1) {
      const [part] = this.#lineParts;
      if (part === undefined) return new Uint8Array(0);
      return part.slice();
    }
    const line = new Uint8Array(this.#lineLength);
    let offset = 0;
    for (const part of this.#lineParts) {
      line.set(part, offset);
      offset += part.length;
    }
    return line;
  }

  #resetLine(): void {
    this.#lineParts = [];
    this.#lineLength = 0;
    this.#lineBytesSeen = 0;
    this.#discardLine = false;
  }

  #decodeLine(line: Uint8Array): FrameDecoderEvent[] {
    const decoded = decodeUtf8Strict(line);
    if (!decoded.ok) {
      const interrupted = this.#pending !== undefined;
      this.#pending = undefined;
      return [
        this.#decodeError(
          interrupted ? "chunk_sequence" : "invalid_utf8",
          interrupted ? "RPC chunk sequence interrupted" : "RPC line is not valid UTF-8",
        ),
      ];
    }

    if (decoded.text.trim().length === 0) {
      if (this.#pending !== undefined) {
        this.#pending = undefined;
        return [this.#decodeError("chunk_sequence", "RPC chunk sequence interrupted")];
      }
      return [];
    }

    let value: unknown;
    try {
      value = JSON.parse(decoded.text);
    } catch {
      const interrupted = this.#pending !== undefined;
      this.#pending = undefined;
      return [
        this.#decodeError(
          interrupted ? "chunk_sequence" : "invalid_json",
          interrupted ? "RPC chunk sequence interrupted" : "RPC line is not valid JSON",
        ),
      ];
    }
    if (!isRecord(value)) {
      const interrupted = this.#pending !== undefined;
      this.#pending = undefined;
      return [
        this.#decodeError(
          interrupted ? "chunk_sequence" : "not_object",
          interrupted ? "RPC chunk sequence interrupted" : "RPC frame must be a JSON object",
        ),
      ];
    }

    if (value.type === "rpc_chunk") return this.#consumeChunk(value);
    if (this.#pending !== undefined) {
      const type = originalType(value);
      this.#pending = undefined;
      return [this.#decodeError("chunk_sequence", "RPC chunk sequence interrupted", type)];
    }

    const limitsError = this.#applyReadyLimits(value);
    if (limitsError) return [limitsError];
    return [{ type: "frame", frame: value }];
  }

  #applyReadyLimits(frame: Record<string, unknown>): FrameDecodeError | undefined {
    if (frame.type !== "ready") return undefined;
    let nextMaxFrameBytes = this.#maxFrameBytes;
    let nextMaxReassembledFrameBytes = this.#maxReassembledFrameBytes;
    if (Object.hasOwn(frame, "maxFrameBytes")) {
      const value = frame.maxFrameBytes;
      if (typeof value !== "number" || !validLimit(value)) {
        return this.#decodeError("ready_limits", "ready.maxFrameBytes is invalid", "ready");
      }
      nextMaxFrameBytes = value;
    }
    if (Object.hasOwn(frame, "maxReassembledFrameBytes")) {
      const value = frame.maxReassembledFrameBytes;
      if (typeof value !== "number" || !validLimit(value)) {
        return this.#decodeError(
          "ready_limits",
          "ready.maxReassembledFrameBytes is invalid",
          "ready",
        );
      }
      nextMaxReassembledFrameBytes = value;
    }
    this.#maxFrameBytes = nextMaxFrameBytes;
    this.#maxReassembledFrameBytes = nextMaxReassembledFrameBytes;
    return undefined;
  }

  #consumeChunk(frame: Record<string, unknown>): FrameDecoderEvent[] {
    const chunkId = frame.chunkId;
    const index = frame.index;
    const count = frame.count;
    const byteLength = frame.byteLength;
    const maxChunkCount = Math.max(
      2,
      Math.ceil(this.#maxReassembledFrameBytes / RPC_CHUNK_PAYLOAD_BYTES),
    );
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > MAX_CHUNK_ID_LENGTH ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      count > maxChunkCount ||
      index >= count ||
      byteLength <= 0 ||
      byteLength > this.#maxReassembledFrameBytes
    ) {
      this.#pending = undefined;
      return [this.#decodeError("chunk_metadata", "Invalid RPC chunk metadata", "rpc_chunk")];
    }

    const bytes = decodeBase64(frame.data);
    if (bytes === undefined || bytes.length === 0) {
      this.#pending = undefined;
      return [this.#decodeError("chunk_data", "Invalid RPC chunk data", "rpc_chunk")];
    }
    if (bytes.length > RPC_CHUNK_PAYLOAD_BYTES) {
      this.#pending = undefined;
      return [
        this.#decodeError(
          "chunk_payload_too_large",
          "RPC chunk payload exceeds the transport limit",
          "rpc_chunk",
        ),
      ];
    }

    if (this.#pending === undefined) {
      if (index !== 0) {
        return [
          this.#decodeError(
            "chunk_sequence",
            "RPC chunk sequence must start at index 0",
            "rpc_chunk",
          ),
        ];
      }
      this.#pending = {
        chunkId,
        count,
        byteLength,
        chunks: [],
        nextIndex: 0,
        receivedBytes: 0,
      };
    }

    const pending = this.#pending;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      this.#pending = undefined;
      return [this.#decodeError("chunk_sequence", "RPC chunk sequence mismatch", "rpc_chunk")];
    }

    pending.chunks.push(bytes);
    pending.nextIndex++;
    pending.receivedBytes += bytes.length;
    if (pending.receivedBytes > pending.byteLength) {
      this.#pending = undefined;
      return [
        this.#decodeError(
          "chunk_length",
          "RPC chunk sequence exceeds its declared length",
          "rpc_chunk",
        ),
      ];
    }
    if (pending.nextIndex < pending.count) return [];
    if (pending.receivedBytes !== pending.byteLength) {
      this.#pending = undefined;
      return [
        this.#decodeError(
          "chunk_length",
          "RPC chunk sequence length does not match its declaration",
          "rpc_chunk",
        ),
      ];
    }

    const completed = pending;
    this.#pending = undefined;
    const payload = new Uint8Array(completed.receivedBytes);
    let offset = 0;
    for (const chunk of completed.chunks) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    const decoded = decodeUtf8Strict(payload);
    if (!decoded.ok) {
      return [
        this.#decodeError(
          "reassembled_invalid_utf8",
          "Reassembled RPC frame is not valid UTF-8",
          "rpc_chunk",
        ),
      ];
    }

    let value: unknown;
    try {
      value = JSON.parse(decoded.text);
    } catch {
      return [
        this.#decodeError(
          "reassembled_invalid_json",
          "Reassembled RPC frame is not valid JSON",
          "rpc_chunk",
        ),
      ];
    }
    if (!isRecord(value)) {
      return [
        this.#decodeError(
          "reassembled_not_object",
          "Reassembled RPC frame must be a JSON object",
          "rpc_chunk",
        ),
      ];
    }
    const limitsError = this.#applyReadyLimits(value);
    if (limitsError) return [limitsError];
    return [{ type: "frame", frame: value }];
  }

  #decodeError(code: FrameDecoderErrorCode, message: string, type?: string): FrameDecodeError {
    return {
      type: "decode_error",
      code,
      message,
      byteLength: this.#currentLineByteLength,
      lineNumber: this.#lineNumber,
      recoverable: true,
      ...(type === undefined ? {} : { originalType: type }),
    };
  }
}
