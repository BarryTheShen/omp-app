import * as path from "node:path";

type Message = { role: string; content?: unknown };
type Request = { messages?: Message[]; stream?: boolean };
/** One tool call an assistant message makes. */
type ToolCall = { tool: string; args: Record<string, unknown>; id?: string };
type Reply =
  | { text: string; thinking?: string; streamed?: boolean }
  | (ToolCall & { thinking?: string })
  | { tools: readonly ToolCall[]; thinking?: string }
  | { failure: string }
  /** `auth_probe` makes the provider refuse the key with HTTP 401, as a real provider does for a bad key. */
  | { unauthorized: string };

/** The calls a tool reply makes: one call, or several in one assistant message. */
function toolCallsOf(
  value: Exclude<Reply, { text: string } | { failure: string } | { unauthorized: string }>,
): readonly ToolCall[] {
  return "tools" in value ? value.tools : [value];
}

/** `long_loop` makes the model run this many bash steps in one turn before it answers. */
const LOOP_STEPS = 60;

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

/** `spawn_steerable_subagent` starts a worker whose task says `nested_steer_child`. That worker keeps taking
 * one-second bash steps until a message that starts with `steer_probe:` reaches it, then yields. The task text
 * itself never contains `steer_probe:`, so a repeated task message cannot count as the steer. It gives up after
 * STEER_WAIT_STEPS steps on its own, so a run that never steers cannot hang the server. */
const STEER_WAIT_STEPS = 90;

function steerChildReply(messages: readonly Message[]): Reply | undefined {
  const start = messages.findIndex(
    (message) => message.role === "user" && text(message.content).includes("nested_steer_child"),
  );
  if (start < 0) return undefined;
  const after = messages.slice(start + 1);
  const steered = after.some(
    (message) => message.role === "user" && text(message.content).includes("steer_probe:"),
  );
  if (steered)
    return {
      tool: "yield",
      args: { data: { summary: "Steer received." } },
      thinking: "The steer arrived, so I will submit.",
    };
  const steps = after.filter((message) => message.role === "tool").length;
  if (steps >= STEER_WAIT_STEPS)
    return {
      tool: "yield",
      args: { data: { summary: "No steer arrived." } },
      thinking: "No steer came in time.",
    };
  return {
    tool: "bash",
    args: { command: `sleep 1; echo steer-wait-${steps}` },
    id: `call_wait_${steps}`,
    thinking: "I am waiting for a steer.",
  };
}

/** How many characters one streamed piece carries, for a reply that is streamed in pieces. */
const STREAMED_PIECE_CHARACTERS = 12;
/** How long the server waits between two streamed pieces, short enough for several to coalesce. */
const STREAMED_PIECE_DELAY_MS = 40;
/** A fenced TypeScript block, streamed in pieces for the code-view e2e so the block grows while it is watched. */
const STREAMED_CODE_REPLY = [
  "Here is the streamed block:",
  "",
  "```typescript",
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (const value of values) {",
  "    total += value;",
  "  }",
  "  return total;",
  "}",
  "",
  "export const answer = sum([1, 2, 3]);",
  "```",
].join("\n");
/**
 * A fenced TypeScript block longer than the code view's short-block limit (2,048 characters), so it is coloured in the
 * background as it grows. The e2e spec builds the same rows (`apps/web/e2e/code-view-stream.spec.ts`).
 */
const STREAMED_LONG_CODE_REPLY = [
  "Here is the long streamed block:",
  "",
  "```typescript",
  ...Array.from(
    { length: 48 },
    (_, index) => `export const value${index}: number = ${index} * 2; // step ${index}`,
  ),
  "```",
].join("\n");

/** The content of a reply, cut into pieces when the reply is streamed in pieces; otherwise one piece. */
function contentDeltas(content: string, inPieces: boolean): string[] {
  if (!inPieces) return [content];
  const pieces: string[] = [];
  for (let start = 0; start < content.length; start += STREAMED_PIECE_CHARACTERS) {
    pieces.push(content.slice(start, start + STREAMED_PIECE_CHARACTERS));
  }
  return pieces;
}

/** `count_reply` turns are counted across the whole fake server, so an answer given again is visibly new. */
let countedReplies = 0;
function reply(request: Request): Reply {
  const messages = request.messages ?? [];
  const steerChild = steerChildReply(messages);
  if (steerChild !== undefined) return steerChild;
  const last = messages.at(-1);
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser >= 0 && text(messages[lastUser]?.content).includes("long_loop")) {
    // One turn of many steps: a tool call per round, each with its own id, no thinking part.
    const done = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (done < LOOP_STEPS)
      return { tool: "bash", args: { command: `echo loop-${done}` }, id: `call_loop_${done}` };
    return { text: "loop finished" };
  }
  if (last?.role === "tool") return { text: `tool said: ${text(last.content)}` };
  const prompt = last?.role === "user" ? text(last.content) : "";
  if (prompt.includes("spawn_steerable_subagent"))
    return {
      tool: "task",
      args: {
        name: "SteerProbe",
        agent: "task",
        task: "nested_steer_child: keep taking steps until a steer arrives from the parent, then yield.",
        solutionSpace: "one tiny task: wait for a steer and return a short summary",
      },
      thinking: "I should start a worker that waits for a steer.",
    };
  if (prompt.includes("spawn_subagent"))
    return {
      tool: "task",
      args: {
        name: "NestedProbe",
        agent: "task",
        task: "nested_probe_child: return a short result by calling yield.",
        solutionSpace: "one tiny task: return a short summary",
      },
      thinking: "I should start one child task.",
    };
  if (prompt.includes("nested_probe_child"))
    return {
      tool: "yield",
      args: { data: { summary: "Nested probe completed." } },
      thinking: "I should submit the result.",
    };
  if (prompt.includes("spawn_failing_subagent"))
    return {
      tool: "task",
      args: {
        name: "FailProbe",
        agent: "task",
        task: "fail_probe_child: fail on purpose so the hub shows a failed worker.",
        solutionSpace: "one tiny task: fail",
      },
      thinking: "I should start one child task that fails.",
    };
  if (prompt.includes("auth_probe")) return { unauthorized: "Invalid API key" };
  if (prompt.includes("fail_probe_child"))
    return { failure: "fake provider failure for the failing subagent" };
  if (prompt.includes("spawn_long_subagent"))
    return {
      tool: "task",
      args: {
        name: "LongProbe",
        agent: "task",
        task: "long_probe_child: run one slow step.",
        solutionSpace: "one slow step",
      },
      thinking: "I should start one slow child task.",
    };
  if (prompt.includes("long_probe_child"))
    return {
      tool: "bash",
      args: { command: "sleep 60; echo long-probe-done" },
      thinking: "I should run the slow step.",
    };
  if (prompt.includes("make_it_big")) return { text: "a".repeat(1_100_000) };
  // One unbroken 306-character token, as a long URL or hash is: the reply must wrap it, not run past its box.
  if (prompt.includes("long_word_probe"))
    return { text: `Token: token-${"a1b2c3d4e5".repeat(30)} end of the token.` };
  if (prompt.includes("abort_slow")) return { text: "slow-stream", thinking: "working" };
  if (prompt.includes("stream_code")) return { text: STREAMED_CODE_REPLY, streamed: true };
  if (prompt.includes("stream_long_code"))
    return { text: STREAMED_LONG_CODE_REPLY, streamed: true };
  if (prompt.includes("ask_user"))
    return {
      tool: "ask",
      args: {
        questions: [
          {
            id: "db",
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      },
      thinking: "I need to ask.",
    };
  if (prompt.includes("make_todos"))
    return {
      tool: "todo",
      args: {
        op: "init",
        list: [{ phase: "Plan", items: ["Write the thing", "Test the thing"] }],
      },
      thinking: "I should track todos.",
    };
  // A bash call, then a write, in one message: write is exclusive, so omp starts it only after the bash.
  if (prompt.includes("run_queued_pair"))
    return {
      tools: [
        { tool: "bash", args: { command: "sleep 20; echo first" }, id: "call_queued_bash" },
        {
          tool: "write",
          args: { path: "queued-pair.txt", content: "second\n" },
          id: "call_queued_write",
        },
      ],
      thinking: "I should run bash, then write.",
    };
  if (prompt.includes("run_bash"))
    return { tool: "bash", args: { command: "echo fixture-tool" }, thinking: "I should run bash." };
  if (prompt.includes("slow_tool"))
    return {
      tool: "bash",
      args: { command: "sleep 7; echo slow-tool-done" },
      thinking: "I should run something slow.",
    };
  if (prompt.includes("count_reply")) {
    countedReplies += 1;
    // The word after the keyword names the turn; omp's own preamble in the prompt is not echoed.
    const word = /count_reply\s+(\S+)/.exec(prompt)?.[1] ?? "";
    return { text: `count-${countedReplies} ${word}`, thinking: "I will count this turn." };
  }
  return { text: "pong", thinking: "I will answer pong." };
}

const agentDir = process.argv[2];
if (agentDir === undefined) throw new Error("usage: fake-openai-server.ts <agentDir>");
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models"))
      return Response.json({
        object: "list",
        data: [{ id: "fake-model", object: "model", owned_by: "fake" }],
      });
    if (!url.pathname.endsWith("/chat/completions"))
      return new Response("not found", { status: 404 });
    const body = (await request.json()) as Request;
    const value = reply(body);
    if ("unauthorized" in value)
      return Response.json(
        {
          error: {
            message: value.unauthorized,
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      );
    if ("failure" in value)
      return Response.json(
        { error: { message: value.failure, type: "invalid_request_error" } },
        { status: 400 },
      );
    if (!body.stream)
      return Response.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: "fake-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "text" in value ? value.text : null },
            finish_reason: "text" in value ? "stop" : "tool_calls",
          },
        ],
        usage,
      });
    const base = {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
    };
    // A reply flagged `streamed` (the `stream_code` keyword) is sent in pieces, a little apart.
    const inPieces = "text" in value && value.streamed === true;
    const chunks = [
      ...(value.thinking === undefined
        ? []
        : [
            {
              ...base,
              choices: [
                { index: 0, delta: { reasoning_content: value.thinking }, finish_reason: null },
              ],
            },
          ]),
      ...("text" in value
        ? contentDeltas(value.text, inPieces).map((content) => ({
            ...base,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          }))
        : toolCallsOf(value).map((call, index) => ({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: call.id ?? `call_${call.tool}`,
                      type: "function",
                      function: { name: call.tool, arguments: JSON.stringify(call.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }))),
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "text" in value ? "stop" : "tool_calls" }],
      },
      { ...base, choices: [], usage },
    ];
    const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
    const stream =
      inPieces ||
      body.messages?.some(
        (message) => message.role === "user" && text(message.content).includes("abort_slow"),
      ) === true;
    if (stream) {
      const bodyStream = new ReadableStream({
        async start(controller) {
          for (const line of lines) {
            controller.enqueue(line);
            await Bun.sleep(inPieces ? STREAMED_PIECE_DELAY_MS : 100);
          }
          controller.enqueue("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(bodyStream, { headers: { "content-type": "text/event-stream" } });
    }
    const payload = `${lines.join("")}data: [DONE]\n\n`;
    return new Response(payload, { headers: { "content-type": "text/event-stream" } });
  },
});
await Bun.write(
  path.join(agentDir, "config.yml"),
  [
    "disabledProviders:",
    "  - agents-md",
    "  - agents",
    "  - native",
    "  - claude",
    "  - codex",
    "  - gemini",
    "  - github",
    "  - opencode",
    "",
  ].join("\n"),
);
await Bun.write(
  path.join(agentDir, "models.yml"),
  [
    "providers:",
    "  fake:",
    `    baseUrl: http://127.0.0.1:${server.port}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: fake-model",
    "        name: Fake Model",
    "        reasoning: true",
    // More models, one with a very long name and id, so layout tests see a list like a real one.
    "      - id: claude-3-5-sonnet-20240620",
    "        name: Claude Sonnet 3.5",
    "        contextWindow: 200000",
    "      - id: claude-3-haiku-20240307",
    "        name: Claude Haiku 3",
    "        contextWindow: 200000",
    "      - id: claude-fable-5",
    "        name: Claude Fable 5",
    "        reasoning: true",
    "        contextWindow: 1000000",
    "      - id: a-model-with-a-deliberately-long-identifier-for-layout-checks-20261007",
    "        name: A model with a deliberately long display name to check that rows are cut with an ellipsis, not clipped",
    "        reasoning: true",
    "        contextWindow: 128000",
    "",
  ].join("\n"),
);
console.log(`READY ${server.port}`);
for await (const _ of Bun.stdin.stream()) {
}
server.stop(true);
