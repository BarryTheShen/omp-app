import { z } from "zod";

const JsonRpcRequest = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();
const InitializeParams = z.object({ protocolVersion: z.string() }).passthrough();

const tools = [
  { name: "echo", description: "Echo input.", inputSchema: { type: "object", properties: {} } },
];
const prompts = [
  { name: "explain", description: "Explains a codebase." },
  {
    name: "docstring",
    description: "First line of a docstring.\n\nArgs:\n    topic: what to explain",
  },
  { name: "plain" },
];
const privateFileRoot = `file:///${["home", "mcp-test"].join("/")}`;
const resources = [
  { uri: `${privateFileRoot}/a.md`, name: "a.md", mimeType: "text/markdown" },
  { uri: `${privateFileRoot}/b.md`, name: "b.md", mimeType: "text/markdown" },
  {
    uri: "https://api.example.test/data?auth=auth-value&sig=sig-value",
    name: "signed",
    mimeType: "application/json",
  },
];

function reply(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const request = JsonRpcRequest.safeParse(value);
    if (!request.success || request.data.id === undefined) continue;
    switch (request.data.method) {
      case "initialize": {
        const params = InitializeParams.safeParse(request.data.params);
        reply(request.data.id, {
          protocolVersion: params.success ? params.data.protocolVersion : "2025-03-26",
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: { name: "omp-app-i1-e2e", version: "1.0.0" },
        });
        break;
      }
      case "tools/list":
        reply(request.data.id, { tools });
        break;
      case "prompts/list":
        reply(request.data.id, { prompts });
        break;
      case "resources/list":
        reply(request.data.id, { resources });
        break;
      case "ping":
        reply(request.data.id, {});
        break;
      default:
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.data.id,
            error: { code: -32601, message: "Method not found" },
          })}\n`,
        );
    }
  }
});
