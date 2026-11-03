/**
 * The type for a reply a service sent without one (#2788). Bun.serve sends application/octet-stream for such a reply,
 * and a browser downloads a page with that type instead of showing it, so a share's gate gives the reply the type the
 * browser would have found itself: the WHATWG MIME Sniffing Standard's "rules for identifying an unknown MIME type"
 * (https://mimesniff.spec.whatwg.org/#rules-for-identifying-an-unknown-mime-type, scriptable). Audio, video and archive
 * signatures are left out: their bytes are binary, so such replies stay application/octet-stream.
 */

/** Bytes a pattern may follow: the standard's whitespace bytes. */
const WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

interface Pattern {
  readonly bytes: readonly number[];
  /** Each input byte is read through its mask: 0xdf makes a letter match in either case, 0x00 any byte. */
  readonly mask: readonly number[];
  readonly skipWhitespace: boolean;
  /** HTML's patterns are followed by a tag-terminating byte: a space or `>`. */
  readonly terminated: boolean;
  readonly type: string;
}

const codes = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/** An HTML tag as the standard lists it: letters in either case, after whitespace, followed by a space or `>`. */
const tag = (text: string): Pattern => ({
  bytes: codes(text),
  mask: [...text].map((character) => (/[A-Z]/.test(character) ? 0xdf : 0xff)),
  skipWhitespace: true,
  terminated: true,
  type: "text/html",
});

const exact = (bytes: readonly number[], type: string, mask = bytes.map(() => 0xff)): Pattern => ({
  bytes,
  mask,
  skipWhitespace: false,
  terminated: false,
  type,
});

const PATTERNS: readonly Pattern[] = [
  ...[
    "<!DOCTYPE HTML",
    "<HTML",
    "<HEAD",
    "<SCRIPT",
    "<IFRAME",
    "<H1",
    "<DIV",
    "<FONT",
    "<TABLE",
    "<A",
    "<STYLE",
    "<TITLE",
    "<B",
    "<BODY",
    "<BR",
    "<P",
    "<!--",
  ].map(tag),
  { ...exact(codes("<?xml"), "text/xml"), skipWhitespace: true },
  exact(codes("%PDF-"), "application/pdf"),
  exact(codes("%!PS-Adobe-"), "application/postscript"),
  // Byte order marks: UTF-16 big- and little-endian, UTF-8.
  exact([0xfe, 0xff, 0x00, 0x00], "text/plain", [0xff, 0xff, 0x00, 0x00]),
  exact([0xff, 0xfe, 0x00, 0x00], "text/plain", [0xff, 0xff, 0x00, 0x00]),
  exact([0xef, 0xbb, 0xbf, 0x00], "text/plain", [0xff, 0xff, 0xff, 0x00]),
  // Images (the standard's section 6.1).
  exact([0x00, 0x00, 0x01, 0x00], "image/x-icon"),
  exact([0x00, 0x00, 0x02, 0x00], "image/x-icon"),
  exact([0x42, 0x4d], "image/bmp"),
  exact(codes("GIF87a"), "image/gif"),
  exact(codes("GIF89a"), "image/gif"),
  exact(
    [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50],
    "image/webp",
    [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  ),
  exact([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"),
  exact([0xff, 0xd8, 0xff], "image/jpeg"),
];

function matches(input: Uint8Array, pattern: Pattern): boolean {
  let at = 0;
  if (pattern.skipWhitespace)
    while (at < input.length && WHITESPACE.has(input[at] as number)) at += 1;
  if (at + pattern.bytes.length + (pattern.terminated ? 1 : 0) > input.length) return false;
  for (const [index, byte] of pattern.bytes.entries())
    if (((input[at + index] as number) & (pattern.mask[index] as number)) !== byte) return false;
  if (!pattern.terminated) return true;
  const next = input[at + pattern.bytes.length];
  return next === 0x20 || next === 0x3e;
}

/** The standard's binary data bytes: control characters other than tab, line feed, form feed, carriage return, escape. */
const binary = (byte: number): boolean =>
  byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1a) || (byte >= 0x1c && byte <= 0x1f);

/** The type a browser gives a reply without one, from its first bytes. */
export function unknownType(head: Uint8Array): string {
  for (const pattern of PATTERNS) if (matches(head, pattern)) return pattern.type;
  return head.some(binary) ? "application/octet-stream" : "text/plain";
}

/** Requests whose replies a browser runs as a script. */
const SCRIPTS = new Set([
  "script",
  "worker",
  "sharedworker",
  "serviceworker",
  "audioworklet",
  "paintworklet",
]);

/**
 * The type for a reply without one, by what the browser asked it for (its `Sec-Fetch-Dest`): a stylesheet or a script
 * gets its own type, since a browser takes either without a type and sniffing would call it text/plain, which a
 * browser refuses as a stylesheet. Anything else is sniffed.
 */
export function typeForUntyped(head: Uint8Array, destination: string | null): string {
  if (destination === "style") return "text/css";
  if (destination !== null && SCRIPTS.has(destination)) return "text/javascript";
  return unknownType(head);
}

/** The standard's resource header: the bytes a browser sniffs at most. */
const SNIFF_BYTES = 1445;
/** How long a slow reply's first bytes are waited for; then what came is sniffed. */
const SNIFF_WAIT_MS = 200;

/**
 * A reply without a type, with the type to send for it. Its first bytes are read (up to 1445, or what came within
 * 200 ms) and given on unchanged before the rest, so a slow stream is held up 200 ms at most.
 */
export async function typedBody(
  body: ReadableStream<Uint8Array>,
  destination: string | null,
): Promise<{ readonly type: string; readonly body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  /** A read still on its way when the wait ran out: the rest of the body starts with it. */
  let pending: ReturnType<typeof reader.read> | null = null;
  const deadline = Date.now() + SNIFF_WAIT_MS;
  while (size < SNIFF_BYTES && !ended) {
    pending ??= reader.read();
    const left = deadline - Date.now();
    const result =
      left <= 0
        ? null
        : await Promise.race([
            pending,
            new Promise<null>((done) => setTimeout(() => done(null), left)),
          ]);
    if (result === null) break;
    pending = null;
    if (result.done) ended = true;
    else {
      head.push(result.value);
      size += result.value.length;
    }
  }
  const sniffed = new Uint8Array(Math.min(size, SNIFF_BYTES));
  let at = 0;
  for (const chunk of head) {
    if (at >= sniffed.length) break;
    const part = chunk.subarray(0, sniffed.length - at);
    sniffed.set(part, at);
    at += part.length;
  }
  return {
    type: typeForUntyped(sniffed, destination),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of head) controller.enqueue(chunk);
        if (ended) controller.close();
      },
      async pull(controller) {
        const result = await (pending ?? reader.read());
        pending = null;
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
  };
}
