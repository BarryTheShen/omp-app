import type { RealToolResult } from "../../U3/tool-card/real-result";

/**
 * Scripted envelopes absent from the recorded session pool. Result text/details follow omp v18.9.1 builders;
 * scrubbed ids, memories and skill names are synthetic. These are not claimed to be recorded calls.
 */
const LONG_MEMORY = "A scrubbed long memory used to exercise T6's bounded preview. "
  .repeat(96)
  .trim();
const LONG_ITEMS = JSON.stringify(
  Array.from({ length: 8 }, (_, index) => ({
    content: `Scrubbed long memory item ${index + 1}. ${"A useful detail. ".repeat(42)}`,
    context: "Scrubbed context.",
  })),
);
const LONG_RECALL = [
  "Found 10 relevant memories (as of 2026-10-07 21:44 UTC):",
  ...Array.from(
    { length: 10 },
    (_, index) => `- Scrubbed memory ${index + 1}. ${"A recorded detail. ".repeat(42)}`,
  ),
].join("\n\n");
const LONG_MISSING_ID = `missing-${"x".repeat(5_000)}`;

export const T6_SOURCE_RESULTS: readonly RealToolResult[] = [
  {
    name: "scripted reflect: no relevant information",
    toolName: "reflect",
    args: { query: "Scrubbed reflection query" },
    result: {
      content: [{ type: "text", text: "No relevant information found to reflect on." }],
      details: {},
    },
    isError: false,
    shows: ["No relevant information found."],
  },
  {
    name: "scripted memory_edit: update completed",
    toolName: "memory_edit",
    args: { op: "update", id: "memory-1", content: "Scrubbed updated memory." },
    result: {
      content: [{ type: "text", text: "Memory memory-1 updated in bank project (working)." }],
      details: { status: "updated", bank: "project", store: "working" },
    },
    isError: false,
    shows: [],
  },
  {
    name: "scripted memory_edit: memory was not found",
    toolName: "memory_edit",
    args: { op: "update", id: "missing-memory", content: "Scrubbed replacement." },
    result: {
      content: [{ type: "text", text: "Memory missing-memory was not found." }],
      details: { status: "not_found" },
    },
    isError: false,
    shows: [],
  },
  {
    name: "scripted memory_edit: memory is not editable",
    toolName: "memory_edit",
    args: { op: "update", id: "readonly-memory", content: "Scrubbed replacement." },
    result: {
      content: [
        {
          type: "text",
          text: "Memory readonly-memory is a read-only fact in bank project (fact); it cannot be edited. Read it with memory://readonly-memory.",
        },
      ],
      details: { status: "not_editable", bank: "project", store: "fact" },
    },
    isError: false,
    shows: [],
  },
  {
    name: "scripted recall: no memories",
    toolName: "recall",
    args: { query: "Scrubbed empty query" },
    result: {
      content: [{ type: "text", text: "No relevant memories found." }],
      details: {},
    },
    isError: false,
    shows: ["No memories found."],
  },
  {
    name: "scripted learn: lesson queued without a skill",
    toolName: "learn",
    args: { memory: "Scrubbed lesson text." },
    result: {
      content: [{ type: "text", text: "Lesson queued for retention." }],
      details: { skill: null },
    },
    isError: false,
    shows: ["Scrubbed lesson text."],
  },
  {
    name: "scripted learn: authored skill shadows creation",
    toolName: "learn",
    args: {
      memory: "Scrubbed lesson text.",
      skill: { name: "sample-skill-shadowed", action: "create", body: "Scrubbed body." },
    },
    result: {
      content: [
        {
          type: "text",
          text: 'Lesson queued for retention. Did not create managed skill "sample-skill-shadowed": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.',
        },
      ],
      details: { skill: null, shadowed: true },
    },
    isError: true,
    shows: ["authored skill of that name already exists"],
  },
  {
    name: "scripted manage_skill: authored skill shadows creation",
    toolName: "manage_skill",
    args: {
      action: "create",
      name: "sample-skill-shadowed",
      description: "Scrubbed description.",
      body: "Scrubbed body.",
    },
    result: {
      content: [
        {
          type: "text",
          text: 'Cannot create managed skill "sample-skill-shadowed": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.',
        },
      ],
      details: { action: "create", name: "sample-skill-shadowed", shadowed: true },
    },
    isError: true,
    shows: ["Cannot create managed skill"],
  },
  {
    name: "scripted recall: large result past the memory text limit",
    toolName: "recall",
    args: { query: "Scrubbed long query" },
    result: { content: [{ type: "text", text: LONG_RECALL }], details: {} },
    isError: false,
    shows: ["Found 10 relevant memories", "Scrubbed memory 1."],
  },
  {
    name: "scripted reflect: large answer past the memory text limit",
    toolName: "reflect",
    args: { query: "Scrubbed long reflection query" },
    result: {
      content: [{ type: "text", text: `Based on recalled memories:\n\n${LONG_MEMORY}` }],
      details: {},
    },
    isError: false,
    shows: ["Based on recalled memories"],
  },
  {
    name: "scripted memory_edit: long id produces omp's not-found result",
    toolName: "memory_edit",
    args: { op: "update", id: LONG_MISSING_ID, content: "Scrubbed replacement." },
    result: {
      content: [{ type: "text", text: `Memory ${LONG_MISSING_ID} was not found.` }],
      details: { status: "not_found" },
    },
    isError: false,
    shows: [],
  },
  {
    name: "scripted retain: large valid batch",
    toolName: "retain",
    args: { items: LONG_ITEMS, i: "Scrubbed large intent" },
    result: {
      content: [{ type: "text", text: "8 memories queued." }],
      details: { count: 8 },
    },
    isError: false,
    shows: ["8 memories queued.", "Scrubbed long memory item 1."],
  },
  {
    name: "scripted learn: large valid lesson",
    toolName: "learn",
    args: { memory: LONG_MEMORY },
    result: {
      content: [{ type: "text", text: "Lesson queued for retention." }],
      details: { skill: null },
    },
    isError: false,
    shows: ["A scrubbed long memory"],
  },
  {
    name: "scripted manage_skill: large valid body",
    toolName: "manage_skill",
    args: {
      action: "update",
      name: "sample-skill-large",
      description: "Scrubbed description.",
      body: LONG_MEMORY,
    },
    result: {
      content: [
        {
          type: "text",
          text: 'Updated managed skill "sample-skill-large" (managed-skills/sample-skill-large/SKILL.md).',
        },
      ],
      details: { action: "update", name: "sample-skill-large" },
    },
    isError: false,
    shows: ["sample-skill-large"],
  },
  {
    name: "scripted xd__recall: tool not found",
    toolName: "xd__recall",
    args: { query: "Scrubbed query" },
    result: {
      content: [{ type: "text", text: "Tool xd__recall not found. Did you mean recall?" }],
      details: { isError: true, error: "Tool xd__recall not found. Did you mean recall?" },
    },
    isError: true,
    shows: ["Tool xd__recall not found. Did you mean recall?"],
  },
];
