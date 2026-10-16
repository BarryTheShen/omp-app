import type { RealToolResult } from "../../U3/tool-card/real-result";

/** The text of a device call that returned many rows: the recorded device answer's shape, with the rows generated. */
const MANY_ROWS = JSON.stringify(
  {
    head: "60 results for example search",
    n: 60,
    rows: Array.from({ length: 60 }, (_, index) => ({
      id: String(100_000_000_000 + index),
      price: `$${250 + index}.00`,
    })),
  },
  null,
  2,
);
/**
 * Real `write` results whose target is not a file: a message to another agent, a background job's
 * kill, and a device (`xd://`) call. Paths and content are replaced; the result shapes are omp's.
 */
export const T1_WRITE_TARGET_RESULTS: readonly RealToolResult[] = [
  {
    name: "write: a message to another agent",
    toolName: "write",
    args: { path: "agent://Worker", content: "Your spec is merged. Take the next assignment." },
    result: {
      content: [{ type: "text", text: "Delivered to Worker." }],
      details: {
        message: {
          op: "send",
          from: "Main",
          to: "Worker",
          receipts: [{ to: "Worker", outcome: "woken" }],
        },
      },
    },
    isError: false,
    shows: ["agent://Worker", "Delivered to Worker."],
  },
  {
    name: "write: a background job stopped through proc://",
    toolName: "write",
    args: { path: "proc://Builder-2-2/kill" },
    result: {
      content: [
        {
          type: "text",
          text: "## Cancelled (1)\n\n- Cancelled background job Builder-2-2.\n\n## Completed (1)\n\n### Builder-2-2 [task] — cancelled\nLabel: Builder-2",
        },
      ],
      details: {
        proc: {
          op: "cancel",
          meta: { source: { type: "report", value: "background jobs snapshot" } },
          jobs: [
            {
              id: "Builder-2-2",
              type: "task",
              status: "cancelled",
              label: "Builder-2",
              durationMs: 811008,
              agentUrlId: "Builder-2",
            },
          ],
          cancelled: [{ id: "Builder-2-2", status: "cancelled" }],
        },
      },
    },
    isError: false,
    shows: ["Cancelled background job Builder-2-2."],
  },
  {
    name: "write: a device call that returns rows",
    toolName: "write",
    args: {
      path: "xd://browser",
      content: '{"action":"run","name":"listings","timeout":90,"code":"return rows"}',
    },
    result: {
      content: [
        {
          type: "text",
          text: '{\n  "head": "10 results for example search",\n  "n": 123,\n  "rows": [\n    {\n      "id": "100000000001",\n      "price": "$250.00"\n    }\n  ]\n}',
        },
      ],
      details: {
        xdev: {
          tool: "browser",
          mode: "execute",
          args: { action: "run", name: "listings", timeout: 90, code: "return rows" },
        },
      },
    },
    isError: false,
    shows: ["10 results for example search"],
  },
  {
    name: "write: a device call that was cancelled",
    toolName: "write",
    args: {
      path: "xd://browser",
      content: '{"action":"open","name":"course","app":{"relay":true}}',
    },
    result: { content: [{ type: "text", text: "Aborted: Cancelled" }], details: {} },
    isError: true,
    shows: ["Aborted: Cancelled"],
  },
  {
    name: "write: a device call that returns many rows",
    toolName: "write",
    args: {
      path: "xd://browser",
      content: '{"action":"run","name":"listings","timeout":90,"code":"return rows"}',
    },
    result: {
      content: [{ type: "text", text: MANY_ROWS }],
      details: {
        // omp also sends `tier` and `inner` here (420 browser successes in the session store carry them); the write card reads only `tool`, so they are left out.
        xdev: {
          tool: "browser",
          mode: "execute",
          args: { action: "run", name: "listings", timeout: 90, code: "return rows" },
        },
      },
    },
    isError: false,
    shows: ["60 results for example search"],
  },
];
