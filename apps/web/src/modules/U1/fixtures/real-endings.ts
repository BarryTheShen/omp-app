/**
 * The assistant entries omp wrote for one question that did not end in a plain answer, and what the
 * transcript must show for it. Built from the real messages in a session store, with private
 * content replaced; never from a shape someone wrote by hand.
 */
export interface RealEnding {
  readonly name: string;
  /** The assistant `message` entries for the question, in order (the harness adds ids). */
  readonly entries: readonly Record<string, unknown>[];
  /** Text the answer's row must show. */
  readonly shows: readonly string[];
  /** Text the row must not show. */
  readonly absent: readonly string[];
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const AT = Date.UTC(2026, 9, 3, 11, 0, 0);

function assistant(
  timestamp: number,
  stopReason: string,
  content: readonly unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message",
    message: {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage,
      stopReason,
      timestamp: AT + timestamp,
      ...extra,
    },
  };
}

export const U1_REAL_ENDINGS: readonly RealEnding[] = [
  {
    name: "error: the model is not there (404)",
    entries: [
      assistant(1_000, "error", [], {
        errorMessage:
          '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"},"request_id":"req_011CfExample"}',
        errorStatus: 404,
      }),
    ],
    shows: ["The model stopped with an error", "not_found_error", "model: claude-opus-5-5"],
    absent: ["Interrupted"],
  },
  {
    name: "error: the stream stalled after some text",
    entries: [
      assistant(2_000, "error", [{ type: "text", text: "Here is the first part of the answer" }], {
        errorMessage: "Anthropic stream stalled while waiting for the next event",
      }),
    ],
    shows: [
      "Here is the first part of the answer",
      "The model stopped with an error",
      "Anthropic stream stalled while waiting for the next event",
    ],
    absent: ["Interrupted"],
  },
  {
    name: "error that omp retried: the answer that followed is all there is to show",
    entries: [
      assistant(3_000, "error", [], {
        errorMessage: "Anthropic stream stalled while waiting for the next event",
        retryRecovery: {
          kind: "auto-retry",
          status: "recovered",
          attempt: 1,
          recoveredAt: "2026-10-03T11:00:04.000Z",
          recovery: "plain",
          note: "error; retried",
          supersededBy: { timestamp: AT + 4_000 },
        },
      }),
      assistant(4_000, "stop", [{ type: "text", text: "The retry answered." }]),
    ],
    shows: ["The retry answered."],
    absent: ["The model stopped with an error", "stream stalled"],
  },
  {
    name: "interrupted while thinking",
    entries: [
      assistant(
        5_000,
        "aborted",
        [{ type: "thinking", thinking: "I will check the holdings first." }],
        {
          errorMessage: "Interrupted by user",
          stopDetails: {
            type: "stream_interrupted_after_content",
            category: null,
            explanation: "Interrupted by user",
          },
        },
      ),
    ],
    shows: ["Interrupted"],
    absent: ["The model stopped with an error"],
  },
  {
    name: "interrupted before any output",
    entries: [assistant(6_000, "aborted", [], { errorMessage: "Request was aborted" })],
    shows: ["Interrupted"],
    absent: ["The model stopped with an error", "Request was aborted"],
  },
  {
    name: "a plain answer shows nothing extra",
    entries: [assistant(7_000, "stop", [{ type: "text", text: "A normal answer." }])],
    shows: ["A normal answer."],
    absent: ["Interrupted", "The model stopped with an error", "Cut off at the length limit"],
  },
];
