import type { RealToolResult } from "../../U3/tool-card/real-result";

/*
 * Source-derived vibe results: send, list, wait and kill. Vibe mode is terminal-only in omp v18.8.9, so no session file
 * holds a recorded result for these four tools, and these samples are NOT recorded. Each text is omp's string literal
 * (cited by file and line, `packages/coding-agent/src/tools/vibe.ts` and `src/vibe/runtime.ts`), and each details value
 * has omp's `VibeToolDetails` shape (`packages/tui/src/tools/vibe.ts:28-110`). Scrubbed: ids are placeholders. A
 * recorded sample replaces one of these when a session file holds one.
 */

const RUNNING_FAST = {
  id: "fast-1",
  cli: "fast",
  state: "running",
  model: "fast-model",
  turns: 2,
  queued: 1,
  turnStartedAt: 1_759_600_000_000,
  turnMessage: "Run the unit tests",
  currentTool: "bash",
  currentToolArgs: "bun test",
  lastIntent: "Run the tests",
  trace: ["read: src/app.ts", "edit: src/app.ts"],
  outputTail: ["Running the suite.", "42 tests so far."],
  lastActivity: "bash: bun test",
  lastActivityAt: 1_759_600_000_500,
} as const;

const IDLE_GOOD = {
  id: "good-2",
  cli: "good",
  state: "idle",
  model: "good-model",
  turns: 1,
  queued: 0,
  trace: [],
  outputTail: ["The plan is ready."],
  lastActivity: "message: plan review",
  lastActivityAt: 1_759_600_100_000,
} as const;

export const T5_VIBE_SOURCE_RESULTS: readonly RealToolResult[] = [
  {
    name: "vibe_send: a new turn (source-derived)",
    toolName: "vibe_send",
    args: { session: "fast-1", message: "Run the unit tests and report the failures." },
    // tools/vibe.ts:121-123 (the turn ack text); details `{ op: "send", ...wallOf, send: outcome }` at :127.
    result: {
      content: [
        {
          type: "text",
          text: "Started a new turn on `fast-1` (job `job-7`). Its result will be delivered when the turn finishes.",
        },
      ],
      details: {
        op: "send",
        screens: [RUNNING_FAST],
        send: { id: "fast-1", mode: "turn", jobId: "job-7" },
      },
    },
    isError: false,
    shows: [
      "Turn started on fast-1",
      "A new turn",
      "job-7",
      "Run the unit tests and report the failures.",
    ],
  },
  {
    name: "vibe_send: steered mid-turn (source-derived)",
    toolName: "vibe_send",
    args: { session: "fast-1", message: "Skip the slow test." },
    // tools/vibe.ts:124-125 (the steered ack text).
    result: {
      content: [
        {
          type: "text",
          text: "Steered `fast-1` mid-turn — the running turn sees your message at its next step.",
        },
      ],
      details: { op: "send", screens: [RUNNING_FAST], send: { id: "fast-1", mode: "steered" } },
    },
    isError: false,
    shows: ["Steered fast-1 mid-turn", "Steered into the running turn", "Skip the slow test."],
  },
  {
    name: "vibe_send: queued behind a turn (source-derived)",
    toolName: "vibe_send",
    args: { session: "good-2", message: "Then write the summary." },
    // tools/vibe.ts:126 (the queued ack text).
    result: {
      content: [
        {
          type: "text",
          text: "`good-2` is mid-turn; your message is queued and runs automatically as the next turn.",
        },
      ],
      details: { op: "send", screens: [IDLE_GOOD], send: { id: "good-2", mode: "queued" } },
    },
    isError: false,
    shows: [
      "Queued for good-2's next turn",
      "Queued after the running turn",
      "Then write the summary.",
    ],
  },
  {
    name: "vibe_send: unknown session (source-derived)",
    toolName: "vibe_send",
    args: { session: "fast-9", message: "Status?" },
    // src/vibe/runtime.ts:502 (the unknown-session error); a ToolError, so the result carries no details.
    result: {
      content: [
        {
          type: "text",
          text: 'Unknown vibe session "fast-9". No sessions — spawn one with vibe_spawn.',
        },
      ],
      details: {},
    },
    isError: true,
    shows: ["Message not delivered", 'Unknown vibe session "fast-9"'],
  },
  {
    name: "vibe_list: live workers and a killed one (source-derived)",
    toolName: "vibe_list",
    args: {},
    // tools/vibe.ts:251-268: one line per screen, then the killed ids with the transcript note.
    result: {
      content: [
        {
          type: "text",
          text: [
            "- `fast-1` [fast] running · 2 turns · 1 queued · fast-model · last: bash: bun test",
            "- `good-2` [good] idle · 1 turn · good-model · last: message: plan review",
            "Killed (1, transcripts at history://<id>): `fast-3`",
          ].join("\n"),
        },
      ],
      details: {
        op: "list",
        screens: [RUNNING_FAST, IDLE_GOOD],
        hiddenKilled: ["fast-3"],
      },
    },
    isError: false,
    shows: [
      "2 vibe workers · 1 killed",
      "fast-1",
      "fast worker",
      "Running",
      "2 turns",
      "1 queued",
      "Now: bash",
      "bun test",
      "good-2",
      "Idle",
      "Killed (1): fast-3",
    ],
  },
  {
    name: "vibe_list: no sessions (source-derived)",
    toolName: "vibe_list",
    args: {},
    // tools/vibe.ts:262 (the empty-wall text).
    result: {
      content: [{ type: "text", text: "No vibe sessions. Spawn one with vibe_spawn." }],
      details: { op: "list", screens: [] },
    },
    isError: false,
    shows: ["No live vibe workers", "No vibe sessions. Spawn one with vibe_spawn."],
  },
  {
    name: "vibe_wait: a turn settled, another still running (source-derived)",
    toolName: "vibe_wait",
    args: { sessions: ["fast-1", "good-2"], timeout: 60 },
    // tools/vibe.ts:182-200: the settled heading with the result text, then the still-running line.
    result: {
      content: [
        {
          type: "text",
          text: "## `fast-1` — completed\nThe unit tests pass.\n\nStill running: `good-2`.",
        },
      ],
      details: {
        op: "wait",
        screens: [RUNNING_FAST, IDLE_GOOD],
        wait: {
          settled: [{ id: "fast-1", jobId: "job-7", status: "completed" }],
          stillRunning: ["good-2"],
          timedOut: false,
        },
      },
    },
    isError: false,
    shows: [
      "1 turn settled",
      "fast-1",
      "Completed",
      "Turn job job-7",
      "Still running: `good-2`",
      "The unit tests pass.",
    ],
  },
  {
    name: "vibe_wait: the wait ran out before any turn settled (source-derived)",
    toolName: "vibe_wait",
    args: { sessions: ["good-2"], timeout: 30 },
    // tools/vibe.ts:201-203: the timed-out line that tells the director to wait again.
    result: {
      content: [
        {
          type: "text",
          text: "Still running: `good-2`.\nWait window elapsed before any turn settled — re-issue vibe_wait to keep waiting.",
        },
      ],
      details: {
        op: "wait",
        screens: [IDLE_GOOD],
        wait: { settled: [], stillRunning: ["good-2"], timedOut: true },
      },
    },
    isError: false,
    shows: [
      "No turn settled before the wait ran out",
      "Wait again to keep waiting.",
      "Still running: good-2",
    ],
  },
  {
    name: "vibe_wait: interrupted by a message, a worker still running (source-derived)",
    toolName: "vibe_wait",
    args: { sessions: ["good-2"], timeout: 60 },
    // src/vibe/runtime.ts:1012-1017: an interrupted wait is a normal result that lists the ids still running
    // (the tool is interruptible: tools/vibe.ts:141). The card shows that text once, not a second fact.
    result: {
      content: [{ type: "text", text: "Still running: `good-2`." }],
      details: {
        op: "wait",
        screens: [IDLE_GOOD],
        wait: { settled: [], stillRunning: ["good-2"], timedOut: false },
      },
    },
    isError: false,
    shows: ["Stopped waiting; 1 worker still running", "Still running: `good-2`."],
  },
  {
    name: "vibe_wait: no turn in flight (source-derived)",
    toolName: "vibe_wait",
    args: {},
    // tools/vibe.ts:192 (the nothing-to-wait-for text).
    result: {
      content: [{ type: "text", text: "No turns in flight to wait for." }],
      details: {
        op: "wait",
        screens: [],
        wait: { settled: [], stillRunning: [], timedOut: false },
      },
    },
    isError: false,
    shows: ["No turns in flight", "No turns in flight to wait for."],
  },
  {
    name: "vibe_kill: a worker whose turn was cancelled (source-derived)",
    toolName: "vibe_kill",
    args: { session: "fast-1" },
    // tools/vibe.ts:224-230: the cancel note and the transcript line.
    result: {
      content: [
        {
          type: "text",
          text: "Killed session `fast-1`. Its in-flight turn was cancelled. Transcript remains at history://fast-1.",
        },
      ],
      details: {
        op: "kill",
        screens: [],
        killed: { id: "fast-1", cancelledTurn: true },
      },
    },
    isError: false,
    shows: ["Killed fast-1", "Its running turn was cancelled."],
  },
  {
    name: "vibe_kill: an idle worker (source-derived)",
    toolName: "vibe_kill",
    args: { session: "good-2" },
    // tools/vibe.ts:226 without the cancel note.
    result: {
      content: [
        {
          type: "text",
          text: "Killed session `good-2`. Transcript remains at history://good-2.",
        },
      ],
      details: { op: "kill", screens: [], killed: { id: "good-2", cancelledTurn: false } },
    },
    isError: false,
    shows: ["Killed good-2", "No running turn was cancelled."],
  },
  {
    name: "vibe_kill: unknown session (source-derived)",
    toolName: "vibe_kill",
    args: { session: "fast-9" },
    // src/vibe/runtime.ts:502 (the unknown-session error); a ToolError, so the result carries no details.
    result: {
      content: [
        {
          type: "text",
          text: 'Unknown vibe session "fast-9". No sessions — spawn one with vibe_spawn.',
        },
      ],
      details: {},
    },
    isError: true,
    shows: ["Worker fast-9 not killed", 'Unknown vibe session "fast-9"'],
  },
];
