import * as path from "node:path";

type Message = { role: string; content?: unknown };
type Request = { messages?: Message[]; stream?: boolean };
type Reply =
  | { text: string; thinking?: string }
  | { tool: string; args: Record<string, unknown>; thinking?: string };

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

function reply(request: Request): Reply {
  const last = request.messages?.at(-1);
  if (last?.role === "tool") return { text: `tool said: ${text(last.content)}` };
  const prompt = last?.role === "user" ? text(last.content) : "";
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
                      id: `call_${value.tool}`,
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
