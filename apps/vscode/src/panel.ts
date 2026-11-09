import { createHash, randomBytes } from "node:crypto";
import type { EmbedFiles, HostContext } from "@omp-app/contracts";
import { appAddressOf } from "@omp-app/embed";
import * as vscode from "vscode";
import type { Reviews } from "./review";
import type { FromExtension, PanelConfig, ToExtension } from "./webview-messages";
import { WorkspaceTools } from "./workspace";

const setting = <T>(name: string, fallback: T): T =>
  vscode.workspace.getConfiguration("ompApp").get<T>(name, fallback);

/** Where the extension keeps the key and the chat: per app, so another app's address pairs anew. */
const keyName = (app: string): string => `ompApp.deviceKey:${app}`;
const chatName = (app: string): string => `ompApp.chat:${app}`;

/** The open folder as the panel tells the app: its name, and an id from its path (the server's folder for it). */
export function filesOf(folder: vscode.WorkspaceFolder | undefined): EmbedFiles | null {
  if (folder === undefined || folder.uri.scheme !== "file") return null;
  const project = folder.name.trim().slice(0, 64) || "project";
  return { project, id: createHash("sha256").update(folder.uri.fsPath).digest("hex").slice(0, 16) };
}

/** The open file and the selection in it, as the panel shows it and sends it with each message. */
export function contextOf(editor: vscode.TextEditor | undefined): HostContext | null {
  if (editor === undefined || !setting("sendOpenFile", true)) return null;
  const document = editor.document;
  if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return null;
  const path = vscode.workspace.asRelativePath(document.uri, false);
  const selection = editor.selection;
  const selected = selection.isEmpty ? "" : document.getText(selection);
  const lines = selection.isEmpty ? "" : `#L${selection.start.line + 1}-${selection.end.line + 1}`;
  return {
    kind: "file",
    title: path.slice(0, 300),
    uri: `${path}${lines}`.slice(0, 2_000),
    ...(selected === "" ? {} : { selection: selected.slice(0, 8_000) }),
  };
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The page when there is no address yet, or it is not one: what to do, with a button to the setting. */
function setupPage(nonce: string, problem: string | null): string {
  const said =
    problem ??
    "Give omp app's address to show its chat here: its tailnet address, as you open it in a browser.";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 16px;line-height:1.5}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 12px;border-radius:2px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head>
<body><p>${escapeHtml(said)}</p><p>In omp app, also turn on <b>Settings → App → Integrations → VS Code</b>.</p>
<button id="set">Set the address</button>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById("set").addEventListener("click",()=>vscode.postMessage({type:"settings"}));</script>
</body></html>`;
}

/** The page that frames the app: its script (`webview.js`) and what it needs, in a JSON block. */
function panelPage(
  webview: vscode.Webview,
  script: vscode.Uri,
  nonce: string,
  config: PanelConfig,
): string {
  const json = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${config.app}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style>html,body,#panel{height:100%;margin:0;padding:0;overflow:hidden}</style></head>
<body><div id="panel"></div>
<script type="application/json" id="omp-app-config">${json}</script>
<script nonce="${nonce}" src="${webview.asWebviewUri(script).toString()}"></script>
</body></html>`;
}

/**
 * One panel: the side bar's view or an editor tab. It shows the app's chat for the open folder, answers the page's
 * questions (the key from VS Code's secret storage, the chat to reopen, the tools' calls) and keeps the open file in
 * step. `keepChat`: the side bar's view reopens its chat; an editor tab starts a new one each time.
 */
export class ChatPanel implements vscode.Disposable {
  readonly #webview: vscode.Webview;
  readonly #context: vscode.ExtensionContext;
  readonly #reviews: Reviews;
  readonly #output: vscode.OutputChannel;
  readonly #keepChat: boolean;
  readonly #listeners: vscode.Disposable[] = [];
  /** Calls still running, by the page's question id: aborting gives one up. */
  readonly #running = new Map<number, AbortController>();
  #app: string | null = null;
  #contextTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    reviews: Reviews,
    output: vscode.OutputChannel,
    keepChat: boolean,
  ) {
    this.#webview = webview;
    this.#context = context;
    this.#reviews = reviews;
    this.#output = output;
    this.#keepChat = keepChat;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    };
    this.#listeners.push(
      webview.onDidReceiveMessage((message: ToExtension | { type: "settings" }) =>
        this.#heard(message),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("ompApp.address")) this.load();
        else if (event.affectsConfiguration("ompApp.sendOpenFile")) this.#sendContext();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.load()),
      vscode.window.onDidChangeActiveTextEditor(() => this.#sendContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.#sendContext()),
    );
    this.load();
  }

  /** Shows the page anew: the app's chat, or what to set first. */
  load(): void {
    this.#giveUpAll();
    const nonce = randomBytes(16).toString("base64");
    const typed = setting("address", "").trim();
    const checked = appAddressOf(typed);
    if ("problem" in checked) {
      this.#app = null;
      this.#webview.html = setupPage(nonce, typed === "" ? null : checked.problem);
      return;
    }
    const app = checked.address;
    this.#app = app;
    this.#webview.html = panelPage(
      this.#webview,
      vscode.Uri.joinPath(this.#context.extensionUri, "dist", "webview.js"),
      nonce,
      {
        app,
        files: filesOf(vscode.workspace.workspaceFolders?.[0]),
        chat: this.#keepChat
          ? (this.#context.workspaceState.get<string>(chatName(app)) ?? null)
          : null,
        context: contextOf(vscode.window.activeTextEditor),
      },
    );
  }

  #post(message: FromExtension): void {
    void this.#webview.postMessage(message);
  }

  #sendContext(): void {
    clearTimeout(this.#contextTimer);
    this.#contextTimer = setTimeout(() => {
      if (this.#app === null) return;
      this.#post({
        ompAppExtension: 1,
        type: "context",
        context: contextOf(vscode.window.activeTextEditor),
      });
    }, 250);
  }

  async #heard(message: ToExtension | { type: "settings" }): Promise<void> {
    if (message.type === "settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "ompApp.address");
      return;
    }
    if (message.type === "give-up") {
      this.#running.get(message.id)?.abort();
      return;
    }
    const app = this.#app;
    if (app === null) return;
    const controller = new AbortController();
    this.#running.set(message.id, controller);
    try {
      this.#post({
        ompAppExtension: 1,
        type: "answer",
        id: message.id,
        value: await this.#answer(app, message, controller.signal),
      });
    } catch (error) {
      this.#post({
        ompAppExtension: 1,
        type: "answer",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#running.delete(message.id);
    }
  }

  async #answer(
    app: string,
    question: ToExtension & { type: "ask" },
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (question.what) {
      case "key":
        return (await this.#context.secrets.get(keyName(app))) ?? null;
      case "keep-key":
        await this.#context.secrets.store(keyName(app), question.key);
        return null;
      case "chat":
        if (this.#keepChat) await this.#context.workspaceState.update(chatName(app), question.chat);
        return null;
      case "tool": {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder === undefined) throw new Error("No folder is open in VS Code.");
        return new WorkspaceTools(folder, this.#reviews, this.#output).run(
          question.name,
          question.args,
          signal,
        );
      }
    }
  }

  #giveUpAll(): void {
    for (const controller of this.#running.values()) controller.abort();
    this.#running.clear();
  }

  dispose(): void {
    clearTimeout(this.#contextTimer);
    this.#giveUpAll();
    for (const listener of this.#listeners) listener.dispose();
  }
}

/** Forgets the key kept for the address set now (`ompApp.forgetKey`). */
export async function forgetKey(context: vscode.ExtensionContext): Promise<string | null> {
  const checked = appAddressOf(setting("address", ""));
  if ("problem" in checked) return null;
  await context.secrets.delete(keyName(checked.address));
  return checked.address;
}
