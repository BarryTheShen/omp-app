import type { SessionFilePath } from "@omp-app/contracts";
import { type SubagentTranscriptPage, SubagentTranscriptPageSchema } from "@/modules/P1/contract";
import { FIXTURE_START, fixtureSessionFile } from "./common";

/**
 * Transcript fixtures for the focused view and the byte cursor. The message shapes follow omp's transcript:
 * an assistant message carries `usage`, whose input, output, cacheRead, cacheWrite and totalTokens are
 * required (packages/catalog/src/types.ts:190-212, omp v18.8.9), and a hidden custom message is a
 * `ttsr-injection` with `display: false` (packages/coding-agent/src/session/agent-session.ts:3080, v18.8.9).
 * omp derives a page's `messages` from its `entries`, so each page's entries carry the same messages.
 * Counts, ids and the zero token counts are synthetic. Every page is parsed through the contract schema.
 */

const WORKER_FILE = fixtureSessionFile("worker-cursor");
const MOVED_FILE = fixtureSessionFile("worker-cursor-moved");

/** A turn with no tokens counted: a synthetic value of omp's required shape. */
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } as const;

function userText(text: string, at: number): Readonly<Record<string, unknown>> {
  return { role: "user", content: [{ type: "text", text }], timestamp: at };
}

function assistantText(text: string, at: number): Readonly<Record<string, unknown>> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage: NO_TOKENS,
    stopReason: "stop",
    timestamp: at,
  };
}

/** omp's answer to one `get_subagent_messages` request: its entries carry the messages, as omp's do. */
function page(
  sessionFile: SessionFilePath,
  fromByte: number,
  nextByte: number,
  messages: readonly Readonly<Record<string, unknown>>[],
  reset = false,
): SubagentTranscriptPage {
  return SubagentTranscriptPageSchema.parse({
    sessionFile,
    fromByte,
    nextByte,
    reset,
    entries: messages.map((message, index) => ({
      type: "message",
      id: `m${index}`,
      parentId: null,
      timestamp: new Date(FIXTURE_START).toISOString(),
      message,
    })),
    messages,
  });
}

/** One read by the focused transcript tail: what it asks omp for, omp's answer and what the tail holds after. */
export interface CursorStep {
  /** The session file the roster records for the worker when the read is asked. */
  readonly recordedFile: SessionFilePath;
  /** The byte the tail asks omp for. */
  readonly askFrom: number;
  /** omp's answer to that request. */
  readonly page: SubagentTranscriptPage;
  /** What the tail holds afterwards: its session file, its byte cursor and how many messages it shows. */
  readonly after: {
    readonly file: SessionFilePath | undefined;
    readonly cursor: number;
    readonly shown: number;
  };
}

export interface CursorScenario {
  readonly name: string;
  readonly steps: readonly CursorStep[];
}

const FIRST_READ: CursorStep = {
  recordedFile: WORKER_FILE,
  askFrom: 0,
  page: page(WORKER_FILE, 0, 120, [userText("Read the fixture.", FIXTURE_START + 1)]),
  after: { file: WORKER_FILE, cursor: 120, shown: 1 },
};

/** Incremental cursor reset: continuation, omp's reset, a moved file, an unplaceable page and an empty page. */
export const TRANSCRIPT_CURSOR_SCENARIOS: readonly CursorScenario[] = [
  {
    name: "the next read continues from the cursor and appends its messages",
    steps: [
      FIRST_READ,
      {
        recordedFile: WORKER_FILE,
        askFrom: 120,
        page: page(WORKER_FILE, 120, 260, [assistantText("Read it.", FIXTURE_START + 2)]),
        after: { file: WORKER_FILE, cursor: 260, shown: 2 },
      },
    ],
  },
  {
    name: "omp's reset replaces what the tail shows, from byte zero",
    steps: [
      FIRST_READ,
      {
        recordedFile: WORKER_FILE,
        askFrom: 120,
        page: page(
          WORKER_FILE,
          0,
          80,
          [userText("Read the fixture again.", FIXTURE_START + 3)],
          true,
        ),
        after: { file: WORKER_FILE, cursor: 80, shown: 1 },
      },
    ],
  },
  {
    name: "a worker whose session file moved starts again at byte zero",
    steps: [
      FIRST_READ,
      {
        recordedFile: MOVED_FILE,
        askFrom: 0,
        page: page(MOVED_FILE, 0, 40, [assistantText("Moved.", FIXTURE_START + 4)]),
        after: { file: MOVED_FILE, cursor: 40, shown: 1 },
      },
    ],
  },
  {
    name: "a page that cannot be placed drops the cursor and keeps the messages on screen",
    steps: [
      FIRST_READ,
      {
        recordedFile: WORKER_FILE,
        askFrom: 120,
        page: page(WORKER_FILE, 200, 300, [assistantText("Gap.", FIXTURE_START + 5)]),
        after: { file: undefined, cursor: 0, shown: 1 },
      },
      {
        recordedFile: WORKER_FILE,
        askFrom: 0,
        page: page(WORKER_FILE, 0, 300, [
          userText("Read the fixture.", FIXTURE_START + 1),
          assistantText("Gap.", FIXTURE_START + 5),
        ]),
        after: { file: WORKER_FILE, cursor: 300, shown: 2 },
      },
    ],
  },
  {
    name: "an empty continuation page changes nothing",
    steps: [
      FIRST_READ,
      {
        recordedFile: WORKER_FILE,
        askFrom: 120,
        page: page(WORKER_FILE, 120, 120, []),
        after: { file: WORKER_FILE, cursor: 120, shown: 1 },
      },
    ],
  },
];

/**
 * A focused, read-only transcript page: a user turn, an assistant turn and a hidden rule injection
 * (`ttsr-injection`, `display: false`). The focused view shows the two turns, in order, and nothing else.
 * Read-only controls are tested in transcript/test/read-only-thread.test.tsx.
 */
export const FOCUSED_TRANSCRIPT_PAGE: SubagentTranscriptPage = page(WORKER_FILE, 0, 300, [
  userText("Read the fixture.", FIXTURE_START + 1),
  assistantText("Read it.", FIXTURE_START + 2),
  {
    role: "custom",
    customType: "ttsr-injection",
    content: [{ type: "text", text: "A rule was triggered." }],
    display: false,
    timestamp: FIXTURE_START + 3,
  },
]);

/** The roles the focused view shows for {@link FOCUSED_TRANSCRIPT_PAGE}, in order. */
export const FOCUSED_TRANSCRIPT_ROLES: readonly string[] = ["user", "assistant"];
