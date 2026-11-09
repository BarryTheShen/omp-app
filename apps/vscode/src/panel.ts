import { createHash, randomBytes } from "node:crypto";
import type { EmbedFiles, HostContext } from "@omp-app/contracts";
import { appAddressOf } from "@omp-app/embed";
import * as vscode from "vscode";
import { whyNotShown } from "./check";
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

/** A button of a note: what it says, and what it asks of the extension. */
interface NoteButton {
  readonly label: string;
  readonly ask: "settings" | "retry";
}

const SET: NoteButton = { label: "Set the address", ask: "settings" };
const RETRY: NoteButton = { label: "Try again", ask: "retry" };
const ADDRESS_FIRST =
  "Give omp app's address to show its chat here: the address you open it at in a browser.";
const TURN_ON = "In omp app, also turn on <b>Settings → App → Integrations → VS Code</b>.";

/** A page that says something in place of the chat, each paragraph HTML, with its buttons. */
function notePage(
  nonce: string,
  paragraphs: readonly string[],
  buttons: readonly NoteButton[],
): string {
  const text = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("");
  const actions = buttons
    .map((button) => `<button data-ask="${button.ask}">${escapeHtml(button.label)}</button>`)
    .join(" ");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 16px;line-height:1.5;overflow-wrap:anywhere}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 12px;border-radius:2px;cursor:pointer;margin:0 6px 6px 0}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head>
<body>${text}${actions}
<script nonce="${nonce}">const vscode=acquireVsCodeApi();for(const button of document.querySelectorAll("button"))button.addEventListener("click",()=>vscode.postMessage({type:button.dataset.ask}));</script>
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
      webview.onDidReceiveMessage((message: ToExtension) => this.#heard(message)),
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

  /** Each load's number: a check that ends after a newer load began is dropped. */
  #loads = 0;

  /**
   * Shows the page anew: what to set first, or the app's chat. The app is shown at once: whether this panel reaches it
   * is for the panel's own page to find, as VS Code's extension may reach the network another way (the computer a remote
   * window is connected to, or VS Code's proxy settings). Only a page that never answers is checked (`#noAnswer`).
   */
  load(): void {
    this.#giveUpAll();
    this.#loads += 1;
    const nonce = randomBytes(16).toString("base64");
    const typed = setting("address", "").trim();
    const checked = appAddressOf(typed);
    this.#app = null;
    if ("problem" in checked) {
      const said = typed === "" ? ADDRESS_FIRST : escapeHtml(checked.problem);
      this.#webview.html = notePage(nonce, [said, TURN_ON], [SET]);
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

  /** Shows why the app does not show, with Try again, and writes it in the output channel. */
  #tell(nonce: string, why: string): void {
    this.#output.appendLine(`omp app: ${why}`);
    this.#app = null;
    this.#giveUpAll();
    this.#webview.html = notePage(nonce, [escapeHtml(why)], [RETRY, SET]);
  }

  /**
   * The app's page never said it listens in the panel: why, as the app tells VS Code's extension, else what to try. The
   * extension may reach the network another way than the panel, so what it cannot reach is said with that in mind.
   */
  async #noAnswer(): Promise<void> {
    const app = this.#app;
    if (app === null) return;
    const loading = this.#loads;
    const why = await whyNotShown(app);
    if (loading !== this.#loads) return;
    const remote = vscode.env.remoteName;
    const where =
      remote === undefined
        ? ""
        : ` This window's extension runs on the computer the window is connected to (${remote}), which may not reach that address even when this computer does.`;
    this.#tell(
      randomBytes(16).toString("base64"),
      why === null
        ? `omp app at ${app} answers, but its page didn't open in this panel. Click Try again; if it stays like this, open ${app} in a browser on this computer to see whether it opens there.`
        : `${why}${where}`,
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

  async #heard(message: ToExtension): Promise<void> {
    if (message.type === "settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "ompApp.address");
      return;
    }
    if (message.type === "retry") {
      this.load();
      return;
    }
    if (message.type === "no-answer") {
      await this.#noAnswer();
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
        try {
          return (await this.#context.secrets.get(keyName(app))) ?? null;
        } catch (error) {
          this.#output.appendLine(
            `omp app: VS Code could not read the panel's key: ${reasonOf(error)}`,
          );
          return null;
        }
      case "keep-key":
        try {
          await this.#context.secrets.store(keyName(app), question.key);
        } catch (error) {
          const reason = reasonOf(error);
          this.#output.appendLine(`omp app: VS Code could not keep the panel's key: ${reason}`);
          void vscode.window.showWarningMessage(
            `VS Code couldn't keep omp app's key (${reason}), so this panel will ask to pair again when it opens next.`,
          );
        }
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

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Forgets the key kept for the address set now (`ompApp.forgetKey`). */
export async function forgetKey(context: vscode.ExtensionContext): Promise<string | null> {
  const checked = appAddressOf(setting("address", ""));
  if ("problem" in checked) return null;
  await context.secrets.delete(keyName(checked.address));
  return checked.address;
}
