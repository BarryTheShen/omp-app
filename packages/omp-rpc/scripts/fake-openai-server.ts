import * as path from "node:path";

type Message = { role: string; content?: unknown };
type Request = { messages?: Message[]; stream?: boolean };
type Reply =
  | { text: string; thinking?: string }
  | { tool: string; args: Record<string, unknown>; thinking?: string; id?: string }
  | { failure: string };

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
  if (prompt.includes("abort_slow")) return { text: "slow-stream", thinking: "working" };
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
  if (prompt.includes("run_bash"))
    return { tool: "bash", args: { command: "echo fixture-tool" }, thinking: "I should run bash." };
  if (prompt.includes("slow_tool"))
    return {
      tool: "bash",
      args: { command: "sleep 7; echo slow-tool-done" },
      thinking: "I should run something slow.",
    };
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
      "text" in value
        ? { ...base, choices: [{ index: 0, delta: { content: value.text }, finish_reason: null }] }
        : {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: value.id ?? `call_${value.tool}`,
                      type: "function",
                      function: { name: value.tool, arguments: JSON.stringify(value.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "text" in value ? "stop" : "tool_calls" }],
      },
      { ...base, choices: [], usage },
    ];
    const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
    const stream =
      body.messages?.some(
        (message) => message.role === "user" && text(message.content).includes("abort_slow"),
      ) === true;
    if (stream) {
      const bodyStream = new ReadableStream({
        async start(controller) {
          for (const line of lines) {
            controller.enqueue(line);
            await Bun.sleep(100);
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
