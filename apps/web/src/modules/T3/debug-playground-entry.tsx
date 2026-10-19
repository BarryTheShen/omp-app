import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { DebugCard } from "./debug";
import { T3_SCRIPTED_DEBUG_SESSIONS_RESULT } from "./fixtures/scripted";

function props(
  toolCallId: string,
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "debug",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

const snapshot = {
  id: "session-1",
  adapter: "js-debug-adapter",
  cwd: "/repo",
  program: "app",
  status: "stopped",
  launchedAt: "2026-10-05T12:00:00Z",
  lastUsedAt: "2026-10-05T12:00:04Z",
  stopReason: "breakpoint",
  frameName: "handleRequest",
  source: { path: "src/main.ts" },
  line: 42,
  column: 5,
  breakpointFiles: 1,
  breakpointCount: 1,
  functionBreakpointCount: 0,
  outputBytes: 120,
  outputTruncated: false,
  needsConfigurationDone: false,
};

const frames = [
  "handleRequest",
  "dispatch",
  "router.handle",
  "next",
  "Layer.handle",
  "serve",
  "Server.emit",
  "parserOnIncoming",
].map((name, index) => ({
  id: index + 1,
  name,
  source: { path: index < 3 ? "src/main.ts" : "node_modules/express/lib/router.js" },
  line: 42 + index * 7,
  column: 5,
}));

function DebugPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t3-debug-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">Debug card</h1>
        <p className="text-muted-foreground text-sm">
          A stopped session, a running step, a failed launch and an evaluated expression
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <DebugCard
          rendererProps={props(
            "debug-stopped",
            { action: "stack_trace" },
            {
              content: [
                { type: "text", text: "Stack trace:\n- #1 handleRequest @ src/main.ts:42:5" },
              ],
              details: {
                action: "stack_trace",
                success: true,
                snapshot,
                stackFrames: frames,
                variables: [
                  { name: "counter", value: "3", type: "number", variablesReference: 0 },
                  {
                    name: "request.path",
                    value: '"/api/orders"',
                    type: "string",
                    variablesReference: 0,
                  },
                  { name: "retries", value: "0", type: "number", variablesReference: 0 },
                ],
                threads: [
                  { id: 1, name: "main" },
                  { id: 2, name: "worker 1" },
                ],
              },
            },
          )}
        />
        <DebugCard
          rendererProps={props(
            "debug-sessions",
            { action: "sessions" },
            T3_SCRIPTED_DEBUG_SESSIONS_RESULT,
          )}
        />
        <DebugCard
          rendererProps={props("debug-running", { action: "step_over" }, undefined, {
            type: "running",
          })}
        />
        <DebugCard
          rendererProps={props(
            "debug-failed",
            { action: "launch", program: "app" },
            {
              content: [
                {
                  type: "text",
                  text: "No debugger adapter available. Installed adapters: none",
                },
              ],
            },
            { type: "incomplete", reason: "error" },
          )}
        />
        <DebugCard
          rendererProps={props(
            "debug-evaluate",
            { action: "evaluate", expression: "counter + 1" },
            {
              content: [{ type: "text", text: "Result: 4\nType: number" }],
              details: {
                action: "evaluate",
                success: true,
                snapshot,
                evaluation: { result: "4", type: "number", variablesReference: 0 },
              },
            },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t3-debug-playground-root");
if (!root) throw new Error("The debug playground root is missing.");
createRoot(root).render(<DebugPlayground />);
