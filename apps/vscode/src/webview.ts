/**
 * The panel's page, in VS Code's webview: it frames omp app's lite view with `@omp-app/embed` and hands everything
 * that needs VS Code to the extension (`panel.ts`) as messages: the key, the chat to reopen, and the tools' calls.
 * The extension sends back answers and the person's open file.
 */
import { type HostContext, type HostTool, openPanel } from "@omp-app/embed";
import { TOOLS } from "./tools";
import type { FromExtension, PanelConfig, Question, ToExtension } from "./webview-messages";

declare function acquireVsCodeApi(): { postMessage(message: ToExtension): void };

const vscode = acquireVsCodeApi();
const config = JSON.parse(
  document.getElementById("omp-app-config")?.textContent ?? "{}",
) as PanelConfig;
const into = document.getElementById("panel");
if (into === null) throw new Error("The panel's page has no place for the frame.");

let nextId = 1;
const waiting = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/** Asks the extension, and waits for its answer; `signal` tells it to give up. */
function ask(question: Question, signal?: AbortSignal): Promise<unknown> {
  const id = nextId++;
  const answer = new Promise<unknown>((resolve, reject) => waiting.set(id, { resolve, reject }));
  vscode.postMessage({ type: "ask", id, ...question } as ToExtension);
  signal?.addEventListener("abort", () => vscode.postMessage({ type: "give-up", id }), {
    once: true,
  });
  return answer;
}

const tools: HostTool[] =
  config.files === null
    ? []
    : TOOLS.map((tool) => ({
        ...tool,
        run: async (args, signal) =>
          (await ask({ what: "tool", name: tool.name, args }, signal)) as string,
      }));

const panel = openPanel({
  app: config.app,
  into,
  host: "vscode",
  title: "omp app",
  ...(config.files === null ? {} : { files: config.files }),
  ...(config.chat === null ? {} : { chat: config.chat }),
  context: config.context,
  tools,
  keys: {
    get: async () => (await ask({ what: "key" })) as string | null,
    set: async (key) => {
      await ask({ what: "keep-key", key });
    },
  },
  onReady: ({ chat }) => {
    void ask({ what: "chat", chat });
  },
  onNoAnswer: () => vscode.postMessage({ type: "no-answer" }),
});

window.addEventListener("message", (event: MessageEvent) => {
  // The app's frame speaks to the library; only VS Code's own messages come here.
  if (event.source === panel.frame.contentWindow) return;
  const message = event.data as FromExtension | null;
  if (message === null || typeof message !== "object" || message.ompAppExtension !== 1) return;
  if (message.type === "answer") {
    const found = waiting.get(message.id);
    if (found === undefined) return;
    waiting.delete(message.id);
    if (message.error === undefined) found.resolve(message.value);
    else found.reject(new Error(message.error));
  } else if (message.type === "context") {
    panel.setContext(message.context as HostContext | null);
  }
});
