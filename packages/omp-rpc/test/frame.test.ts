import { describe, expect, test } from "bun:test";
import {
  type FrameDecodeError,
  FrameDecoder,
  type FrameDecoderEvent,
  RPC_CHUNK_PAYLOAD_BYTES,
} from "../src";

const encoder = new TextEncoder();

function line(frame: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(frame)}\n`);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function chunkLines(
  json: string,
  options: { chunkId?: string; splitAt?: number[] } = {},
): Uint8Array[] {
  const payload = encoder.encode(json);
  const splitAt = options.splitAt ?? [Math.ceil(payload.length / 2)];
  const ends = [...splitAt, payload.length];
  const starts = [0, ...splitAt];
  const chunkId = options.chunkId ?? "chunk-1";
  return ends.map((end, index) => {
    const start = starts[index];
    if (start === undefined) throw new Error("missing chunk start");
    const bytes = payload.slice(start, end);
    return line({
      type: "rpc_chunk",
      chunkId,
      index,
      count: ends.length,
      byteLength: payload.length,
      data: base64(bytes),
    });
  });
}

function chunkAt(chunks: Uint8Array[], index: number): Uint8Array {
  const chunk = chunks[index];
  if (chunk === undefined) throw new Error("missing chunk");
  return chunk;
}

function errorCode(events: FrameDecoderEvent[]): FrameDecodeError["code"] {
  const event = events[0];
  if (event?.type !== "decode_error") throw new Error("expected a decode error");
  return event.code;
}

function collect(decoder: FrameDecoder, chunks: Uint8Array[]): FrameDecoderEvent[] {
  return chunks.flatMap((chunk) => decoder.push(chunk));
}

describe("FrameDecoder JSONL transport", () => {
  test("splits arbitrary byte chunks and preserves UTF-8 code points", () => {
    const decoder = new FrameDecoder();
    const bytes = line({ type: "notice", message: "héllo 🌍" });
    const events = bytes.reduce<FrameDecoderEvent[]>(
      (all, _, index) => all.concat(decoder.push(bytes.slice(index, index + 1))),
      [],
    );

    expect(events).toEqual([{ type: "frame", frame: { type: "notice", message: "héllo 🌍" } }]);
  });

  test("handles multiple physical lines in one chunk and ignores blank lines", () => {
    const decoder = new FrameDecoder();
    const events = decoder.push(
      encoder.encode('\n{"type":"ready"}\n{"type":"response","id":"1"}\n'),
    );

    expect(events).toEqual([
      { type: "frame", frame: { type: "ready" } },
      { type: "frame", frame: { type: "response", id: "1" } },
    ]);
  });

  test("turns malformed JSON and non-object JSON into recoverable typed errors", () => {
    const decoder = new FrameDecoder();
    const malformed = decoder.push(encoder.encode("{not-json}\n"));
    const primitive = decoder.push(encoder.encode("[]\n"));
    const recovered = decoder.push(line({ type: "ready" }));

    expect(errorCode(malformed)).toBe("invalid_json");
    expect(errorCode(primitive)).toBe("not_object");
    expect(recovered).toEqual([{ type: "frame", frame: { type: "ready" } }]);
    expect(malformed[0]).toMatchObject({
      type: "decode_error",
      recoverable: true,
      lineNumber: 1,
      byteLength: 11,
    });
    const secret = "sk-fake-key";
    const secretError = new FrameDecoder().push(encoder.encode(`{"apiKey":"${secret}"\n`));
    expect(JSON.stringify(secretError)).not.toContain(secret);
  });

  test("rejects invalid UTF-8 and recovers on the next line", () => {
    const decoder = new FrameDecoder();
    const invalid = decoder.push(Uint8Array.from([0xc3, 0x28, 0x0a]));
    const recovered = decoder.push(line({ type: "notice", message: "ok" }));

    expect(errorCode(invalid)).toBe("invalid_utf8");
    expect(recovered).toEqual([{ type: "frame", frame: { type: "notice", message: "ok" } }]);
  });

  test("enforces the physical frame limit including the newline and then recovers", () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 12, maxReassembledFrameBytes: 128 });
    const events = decoder.push(encoder.encode('{"x":"123456789"}\n'));
    const recovered = decoder.push(line({}));

    expect(errorCode(events)).toBe("line_too_large");
    expect(recovered).toEqual([{ type: "frame", frame: {} }]);
  });

  test("reports a truncated final line without poisoning a new decoder use", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(encoder.encode('{"type":"ready"}'))).toEqual([]);
    expect(errorCode(decoder.finish())).toBe("truncated_line");
    expect(decoder.push(line({ type: "ok" }))).toEqual([{ type: "frame", frame: { type: "ok" } }]);
  });

  test("passes a valid rpc_frame_error wire frame through as a normal frame", () => {
    const decoder = new FrameDecoder();
    const frame = {
      type: "rpc_frame_error",
      error: "event was too large",
      originalType: "agent_end",
    };

    expect(decoder.push(line(frame))).toEqual([{ type: "frame", frame }]);
  });
});

describe("FrameDecoder v2 rpc_chunk", () => {
  test("reassembles chunks split at arbitrary boundaries", () => {
    const decoder = new FrameDecoder({
      maxFrameBytes: 512,
      maxReassembledFrameBytes: RPC_CHUNK_PAYLOAD_BYTES * 5,
    });
    const json = JSON.stringify({ type: "response", id: "1", data: { text: "héllo 🌍" } });
    const chunks = chunkLines(json, { splitAt: [1, 4, 7, 13] });

    expect(collect(decoder, chunks)).toEqual([
      { type: "frame", frame: { type: "response", id: "1", data: { text: "héllo 🌍" } } },
    ]);
  });

  test("takes the reassembly limit from the ready frame", () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    const ready = decoder.push(
      line({ type: "ready", maxFrameBytes: 512, maxReassembledFrameBytes: 20 }),
    );
    const json = JSON.stringify({ type: "response", data: "too large" });
    const chunks = chunkLines(json);

    expect(ready).toEqual([
      { type: "frame", frame: { type: "ready", maxFrameBytes: 512, maxReassembledFrameBytes: 20 } },
    ]);
    expect(errorCode(decoder.push(chunkAt(chunks, 0)))).toBe("chunk_metadata");
    expect(decoder.push(line({ type: "ok" }))).toEqual([{ type: "frame", frame: { type: "ok" } }]);
  });

  test("rejects malformed chunk metadata", () => {
    const badFrames: unknown[] = [
      { type: "rpc_chunk", chunkId: "", index: 0, count: 2, byteLength: 2, data: "e30=" },
      { type: "rpc_chunk", chunkId: "id", index: 0.5, count: 2, byteLength: 2, data: "e30=" },
      { type: "rpc_chunk", chunkId: "id", index: 0, count: 1, byteLength: 2, data: "e30=" },
      { type: "rpc_chunk", chunkId: "id", index: 2, count: 2, byteLength: 2, data: "e30=" },
      { type: "rpc_chunk", chunkId: "id", index: 0, count: 2, byteLength: 0, data: "e30=" },
      { type: "rpc_chunk", chunkId: "id", index: 0, count: 2, byteLength: 257, data: "e30=" },
    ];

    for (const badFrame of badFrames) {
      const decoder = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
      expect(errorCode(decoder.push(line(badFrame)))).toBe("chunk_metadata");
      expect(decoder.push(line({ type: "ok" }))).toEqual([
        { type: "frame", frame: { type: "ok" } },
      ]);
    }
  });

  test("rejects invalid and non-canonical base64 chunk data", () => {
    const badData = ["not-base64", "e30", "e=30", "eh=="];
    for (const data of badData) {
      const decoder = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
      expect(
        errorCode(
          decoder.push(
            line({ type: "rpc_chunk", chunkId: "id", index: 0, count: 2, byteLength: 2, data }),
          ),
        ),
      ).toBe("chunk_data");
    }
  });

  test("rejects a payload over the per-chunk transport limit", () => {
    const decoder = new FrameDecoder({
      maxFrameBytes: 1024 * 1024,
      maxReassembledFrameBytes: 1024 * 1024,
    });
    const bytes = new Uint8Array(RPC_CHUNK_PAYLOAD_BYTES + 1);

    expect(
      errorCode(
        decoder.push(
          line({
            type: "rpc_chunk",
            chunkId: "id",
            index: 0,
            count: 2,
            byteLength: bytes.length,
            data: base64(bytes),
          }),
        ),
      ),
    ).toBe("chunk_payload_too_large");
  });

  test("rejects interleaved and interrupted sequences and recovers", () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    const chunks = chunkLines(JSON.stringify({ type: "response", data: "hello" }), {
      chunkId: "first",
    });
    const other = chunkLines(JSON.stringify({ type: "response", data: "other" }), {
      chunkId: "second",
    });

    expect(decoder.push(chunkAt(chunks, 0))).toEqual([]);
    expect(errorCode(decoder.push(chunkAt(other, 0)))).toBe("chunk_sequence");
    expect(decoder.push(line({ type: "ok" }))).toEqual([{ type: "frame", frame: { type: "ok" } }]);

    expect(decoder.push(chunkAt(chunks, 0))).toEqual([]);
    expect(errorCode(decoder.push(line({ type: "notice" })))).toBe("chunk_sequence");
    expect(decoder.push(line({ type: "ok" }))).toEqual([{ type: "frame", frame: { type: "ok" } }]);
  });

  test("reports an interrupted chunk sequence at end of stream", () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    const chunks = chunkLines(JSON.stringify({ type: "response", data: "pending" }));

    expect(decoder.push(chunkAt(chunks, 0))).toEqual([]);
    expect(errorCode(decoder.finish())).toBe("chunk_sequence");
    expect(decoder.push(line({ type: "ok" }))).toEqual([{ type: "frame", frame: { type: "ok" } }]);
  });

  test("rejects index, count and byte-length sequence mismatches", () => {
    const decoder = new FrameDecoder({
      maxFrameBytes: 512,
      maxReassembledFrameBytes: RPC_CHUNK_PAYLOAD_BYTES * 3,
    });
    const chunks = chunkLines(JSON.stringify({ type: "response", data: "hello" }));
    const first = JSON.parse(new TextDecoder().decode(chunkAt(chunks, 0))) as Record<
      string,
      unknown
    >;

    expect(decoder.push(chunkAt(chunks, 0))).toEqual([]);
    expect(
      errorCode(decoder.push(line({ ...first, index: 1, count: Number(first.count) + 1 }))),
    ).toBe("chunk_sequence");
    expect(decoder.push(line({ type: "ok" }))).toEqual([{ type: "frame", frame: { type: "ok" } }]);

    const shortDecoder = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    expect(shortDecoder.push(chunkAt(chunks, 0))).toEqual([]);
    const last = JSON.parse(new TextDecoder().decode(chunkAt(chunks, 1))) as Record<
      string,
      unknown
    >;
    expect(
      errorCode(shortDecoder.push(line({ ...last, byteLength: Number(last.byteLength) + 1 }))),
    ).toBe("chunk_sequence");
  });

  test("rejects sequence byte counts that are too long or too short", () => {
    const tooLong = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    const payload = encoder.encode("{}");
    expect(
      tooLong.push(
        line({
          type: "rpc_chunk",
          chunkId: "id",
          index: 0,
          count: 2,
          byteLength: 2,
          data: base64(payload),
        }),
      ),
    ).toEqual([]);
    expect(
      errorCode(
        tooLong.push(
          line({
            type: "rpc_chunk",
            chunkId: "id",
            index: 1,
            count: 2,
            byteLength: 2,
            data: base64(payload.slice(1)),
          }),
        ),
      ),
    ).toBe("chunk_length");

    const tooShort = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    expect(
      tooShort.push(
        line({
          type: "rpc_chunk",
          chunkId: "id",
          index: 0,
          count: 2,
          byteLength: 3,
          data: base64(payload.slice(0, 1)),
        }),
      ),
    ).toEqual([]);
    expect(
      errorCode(
        tooShort.push(
          line({
            type: "rpc_chunk",
            chunkId: "id",
            index: 1,
            count: 2,
            byteLength: 3,
            data: base64(payload.slice(1)),
          }),
        ),
      ),
    ).toBe("chunk_length");
  });

  test("strictly decodes reassembled UTF-8 and requires one JSON object", () => {
    const invalidUtf8 = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    const invalidBytes = Uint8Array.from([0xc3, 0x28]);
    expect(
      invalidUtf8.push(
        line({
          type: "rpc_chunk",
          chunkId: "invalid",
          index: 0,
          count: 2,
          byteLength: invalidBytes.length,
          data: base64(invalidBytes.slice(0, 1)),
        }),
      ),
    ).toEqual([]);
    expect(
      errorCode(
        invalidUtf8.push(
          line({
            type: "rpc_chunk",
            chunkId: "invalid",
            index: 1,
            count: 2,
            byteLength: invalidBytes.length,
            data: base64(invalidBytes.slice(1)),
          }),
        ),
      ),
    ).toBe("reassembled_invalid_utf8");

    const invalidJson = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    expect(errorCode(collect(invalidJson, chunkLines("{not-json")))).toBe(
      "reassembled_invalid_json",
    );

    const primitive = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
    expect(errorCode(collect(primitive, chunkLines("[]")))).toBe("reassembled_not_object");
  });

  test("recovers after every completed-sequence decode error", () => {
    const badPayloads = ["{not-json", "[]"];
    for (const badPayload of badPayloads) {
      const decoder = new FrameDecoder({ maxFrameBytes: 512, maxReassembledFrameBytes: 256 });
      expect(collect(decoder, chunkLines(badPayload))).toHaveLength(1);
      expect(decoder.push(line({ type: "ok" }))).toEqual([
        { type: "frame", frame: { type: "ok" } },
      ]);
    }
  });
});
