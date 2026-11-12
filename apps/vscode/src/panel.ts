import { createHash, randomBytes } from "node:crypto";
import type { EmbedFiles, HostContext } from "@omp-app/contracts";
import { appAddressOf, opensOutside } from "@omp-app/embed";
import * as vscode from "vscode";
import { whyNotShown } from "./check";
import { contextFor, type EditorView, type Selected } from "./context";
import { proxyFor } from "./proxy";
import type { Reviews } from "./review";
import type { FromExtension, PanelConfig, ToExtension } from "./webview-messages";
import { WorkspaceTools } from "./workspace";

const setting = <T>(name: string, fallback: T): T =>
  vscode.workspace.getConfiguration("ompApp").get<T>(name, fallback);

/**
 * How long VS Code's window takes to go around its proxy after the extension adds an address to `http.noProxy`: the
 * window reads the setting from the settings file once the change is written, with nothing an extension can wait for.
 */
const PROXY_APPLY_MS = 1_000;

/** Resolves once `key` changes in this window's settings, or after `ms`. */
function changeOf(key: string, ms: number): Promise<void> {
  return new Promise((done) => {
    const finish = (): void => {
      clearTimeout(timer);
      listening.dispose();
      done();
    };
    const timer = setTimeout(finish, ms);
    const listening = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(key)) finish();
    });
  });
}

/** Where the extension keeps the key and the chat: per app, so another app's address pairs anew. */
const keyName = (app: string): string => `ompApp.deviceKey:${app}`;
const chatName = (app: string): string => `ompApp.chat:${app}`;

/** The open folder as the panel tells the app: its name, and an id from its path (the server's folder for it). */
export function filesOf(folder: vscode.WorkspaceFolder | undefined): EmbedFiles | null {
  if (folder === undefined || folder.uri.scheme !== "file") return null;
  const project = folder.name.trim().slice(0, 64) || "project";
  return { project, id: createHash("sha256").update(folder.uri.fsPath).digest("hex").slice(0, 16) };
}

/** A file's path as a context gives it: relative to the open folder; only for files on disk or not yet saved. */
function pathOf(uri: vscode.Uri): string | null {
  if (uri.scheme !== "file" && uri.scheme !== "untitled") return null;
  return vscode.workspace.asRelativePath(uri, false);
}

/** What is selected in an editor, if anything. */
function selectedIn(editor: vscode.TextEditor | undefined): Selected | undefined {
  if (editor === undefined || editor.selection.isEmpty) return undefined;
  const { start, end } = editor.selection;
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
    text: editor.document.getText(editor.selection),
  };
}

/** The editor showing a document: the active one when it does, else a visible one (the focus may be in the panel). */
function editorOf(uri: vscode.Uri): vscode.TextEditor | undefined {
  const key = uri.toString();
  const active = vscode.window.activeTextEditor;
  if (active?.document.uri.toString() === key) return active;
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
}

/** A notebook: the cell with the cursor, else the first selected cell, and what is selected in it. */
function notebookView(editor: vscode.NotebookEditor): EditorView | null {
  const path = pathOf(editor.notebook.uri);
  if (path === null) return null;
  const typing = vscode.window.activeTextEditor;
  const cells = editor.notebook.getCells();
  const typed =
    typing === undefined ? undefined : cells.find((cell) => cell.document === typing.document);
  const first = editor.selections.find((range) => !range.isEmpty);
  const cell = typed ?? (first === undefined ? undefined : editor.notebook.cellAt(first.start));
  if (cell === undefined) return { kind: "notebook", path };
  const selected = selectedIn(typed !== undefined ? typing : editorOf(cell.document.uri));
  return {
    kind: "notebook",
    path,
    cell: {
      index: cell.index,
      text: cell.document.getText(),
      ...(selected === undefined ? {} : { selected }),
    },
  };
}

/** The panel's own tab, when it is opened as an editor ("ompApp.chatTab"; VS Code may prefix its view type). */
const isPanelTab = (tab: vscode.Tab): boolean =>
  tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("ompApp.chatTab");

/** The tab the person is looking at: the active group's, or, while they type in the panel's own tab, another group's. */
function lookedAtTab(): vscode.Tab | undefined {
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (active === undefined || !isPanelTab(active)) return active;
  return vscode.window.tabGroups.all
    .map((group) => group.activeTab)
    .find((tab) => tab !== undefined && !isPanelTab(tab));
}

/** What the person is looking at in VS Code: the tab's file, notebook or view; with no tab, the active editor. */
function editorView(): EditorView | null {
  const tab = lookedAtTab();
  const input = tab?.input;
  if (input instanceof vscode.TabInputNotebook) {
    const key = input.uri.toString();
    const editor =
      vscode.window.activeNotebookEditor?.notebook.uri.toString() === key
        ? vscode.window.activeNotebookEditor
        : vscode.window.visibleNotebookEditors.find((each) => each.notebook.uri.toString() === key);
    if (editor !== undefined) return notebookView(editor);
    const path = pathOf(input.uri);
    return path === null ? null : { kind: "notebook", path };
  }
  const text =
    input instanceof vscode.TabInputText
      ? input.uri
      : input instanceof vscode.TabInputTextDiff
        ? input.modified
        : tab === undefined
          ? vscode.window.activeTextEditor?.document.uri
          : undefined;
  if (text !== undefined) {
    const path = pathOf(text);
    if (path === null) return null;
    const selected = selectedIn(editorOf(text));
    return { kind: "text", path, ...(selected === undefined ? {} : { selected }) };
  }
  if (tab === undefined) return null;
  if (input instanceof vscode.TabInputCustom) {
    const path = pathOf(input.uri);
    return { kind: "tab", label: tab.label, ...(path === null ? {} : { path }) };
  }
  // A webview such as a Markdown preview: its label. A terminal, the settings or the like: nothing.
  return input instanceof vscode.TabInputWebview ? { kind: "tab", label: tab.label } : null;
}

/**
 * What goes with each message: what the person is looking at in VS Code, a text file, a notebook's cell or another
 * tab, with the selection (`context.ts`); nothing when the `sendOpenFile` setting is off.
 */
export function editorContext(): HostContext | null {
  if (!setting("sendOpenFile", true)) return null;
  return contextFor(editorView());
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
  readonly ask: "settings";
}

const SET: NoteButton = { label: "Set the address", ask: "settings" };
const ADDRESS_FIRST =
  "Give omp app's address to show its chat here: the address you open it at in a browser.";

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

/**
 * The page that frames the app: its script (`webview.js`) and what it needs, in a JSON block. `#note` is where the page
 * says why the app's page has not opened yet, over the frame, which keeps loading under it.
 */
function panelPage(
  webview: vscode.Webview,
  script: vscode.Uri,
  nonce: string,
  config: PanelConfig,
): string {
  const json = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${config.app}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<style>html,body,#panel{height:100%;margin:0;padding:0;overflow:hidden}
#note{position:fixed;inset:0;overflow:auto;padding:12px 16px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);line-height:1.5;overflow-wrap:anywhere}
#note[hidden]{display:none}
#note button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 12px;border-radius:2px;cursor:pointer;margin:0 6px 6px 0}
#note button:hover{background:var(--vscode-button-hoverBackground)}</style></head>
<body><div id="panel"></div><div id="note" role="status" hidden></div>
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
      vscode.window.onDidChangeActiveNotebookEditor(() => this.#sendContext()),
      vscode.window.onDidChangeNotebookEditorSelection(() => this.#sendContext()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.#sendContext()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.#sendContext()),
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
      this.#webview.html = notePage(nonce, [said], [SET]);
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
        context: editorContext(),
      },
    );
  }

  /**
   * The app's page never said it listens in the panel: why, as the app tells VS Code's extension, else what to try, said
   * over the frame, which keeps loading under it: a page that answers late takes its place back (`webview.ts`). The
   * extension may reach the network another way than the panel, so what it cannot reach is said with that in mind. An
   * app that can't be reached through VS Code's own proxy gets the proxy named, with Connect without the proxy.
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
    const http = vscode.workspace.getConfiguration("http");
    const proxy =
      why?.kind === "unreachable"
        ? proxyFor(app, {
            proxy: http.get<string>("proxy", ""),
            noProxy: http.get<string[]>("noProxy", []),
            env: process.env,
          })
        : null;
    if (why !== null) this.#output.appendLine(`omp app: ${why.text}`);
    const text =
      why === null
        ? `omp app at ${app} answers, but its page didn't open in this panel. Click Try again; if it stays like this, open ${app} in a browser on this computer to see whether it opens there.`
        : proxy === null
          ? `${why.text}${where}`
          : `VS Code connects through the proxy ${proxy.proxy} (from ${proxy.from}), which can't reach omp app at ${app}: a proxy often doesn't know addresses on your own network, such as Tailscale names. Connect without the proxy adds ${new URL(app).hostname} to VS Code's http.noProxy setting.${where}`;
    if (why === null || proxy !== null) this.#output.appendLine(`omp app: ${text}`);
    this.#post({
      ompAppExtension: 1,
      type: "note",
      text,
      ...(proxy === null ? {} : { proxy: true }),
    });
  }

  /** Adds the app's host to `http.noProxy`, so VS Code reaches the app without its proxy, then shows the panel anew. */
  async #connectDirectly(): Promise<void> {
    const app = this.#app;
    if (app === null) return;
    const host = new URL(app).hostname;
    const http = vscode.workspace.getConfiguration("http");
    const listed = http.get<string[]>("noProxy", []);
    if (!listed.includes(host)) {
      const changed = changeOf("http.noProxy", 3_000);
      try {
        await http.update("noProxy", [...listed, host], vscode.ConfigurationTarget.Global);
      } catch (error) {
        const text = `VS Code's http.noProxy setting couldn't be changed (${error instanceof Error ? error.message : String(error)}). Add ${host} to it in Settings, then click Try again.`;
        this.#output.appendLine(`omp app: ${text}`);
        this.#post({ ompAppExtension: 1, type: "note", text });
        return;
      }
      await changed;
      await new Promise((done) => setTimeout(done, PROXY_APPLY_MS));
      this.#output.appendLine(
        `omp app: added ${host} to VS Code's http.noProxy setting, so VS Code reaches omp app without the proxy.`,
      );
    }
    this.load();
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
        context: editorContext(),
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
    if (message.type === "connect-directly") {
      await this.#connectDirectly();
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
      case "open":
        // Only the app's own pages (the full app) and the desktop app's `omp-app://` link; VS Code says whether it did.
        if (!opensOutside(question.url, new URL(app).origin)) return false;
        return vscode.env.openExternal(vscode.Uri.parse(question.url));
      case "copy":
        await vscode.env.clipboard.writeText(question.text);
        return true;
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
