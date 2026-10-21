// A stdio MCP server for the first-list e2e. It answers `initialize` after a delay, and lists one tool and two prompts.
// argv: <initialize delay in ms> <log file>. Each start and each request is appended to the log, so a test can count
// the server's starts.
import { appendFileSync } from "node:fs";

const delay = Number(process.argv[2] ?? 0);
const logFile = process.argv[3];
const prompts = [{ name: "explain", description: "Explains a codebase." }, { name: "plain" }];

if (logFile) appendFileSync(logFile, `${Date.now()} spawn pid=${process.pid}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    let message: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    const id = message.id;
    const send = (result: unknown) =>
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    if (logFile) appendFileSync(logFile, `${Date.now()} ${message.method} pid=${process.pid}\n`);
    switch (message.method) {
      case "initialize":
        setTimeout(
          () =>
            send({
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {}, prompts: {} },
              serverInfo: { name: "stub", version: "1" },
            }),
          delay,
        );
        break;
      case "tools/list":
        send({ tools: [] });
        break;
      case "prompts/list":
        send({ prompts });
        break;
      case "ping":
        send({});
        break;
      default:
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "no" } })}\n`,
        );
    }
  }
});
