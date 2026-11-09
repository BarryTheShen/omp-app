import * as vscode from "vscode";
import { ChatPanel, forgetKey } from "./panel";
import { REVIEW_SCHEME, Reviews } from "./review";

/** VS Code starts the extension: the side bar's chat, the editor-tab chat, and the commands of a change's review. */
export function activate(context: vscode.ExtensionContext): void {
  const reviews = new Reviews();
  const output = vscode.window.createOutputChannel("omp app");

  context.subscriptions.push(
    output,
    { dispose: () => reviews.rejectAll() },
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, reviews),
    vscode.window.registerWebviewViewProvider(
      "ompApp.chat",
      {
        resolveWebviewView(view) {
          const panel = new ChatPanel(view.webview, context, reviews, output, true);
          view.onDidDispose(() => panel.dispose());
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("ompApp.openInEditor", () => {
      const tab = vscode.window.createWebviewPanel(
        "ompApp.chatTab",
        "omp app",
        vscode.ViewColumn.Beside,
        {
          retainContextWhenHidden: true,
        },
      );
      const panel = new ChatPanel(tab.webview, context, reviews, output, false);
      tab.onDidDispose(() => panel.dispose());
    }),
    vscode.commands.registerCommand("ompApp.acceptChange", () => reviews.decideActive(true)),
    vscode.commands.registerCommand("ompApp.rejectChange", () => reviews.decideActive(false)),
    vscode.commands.registerCommand("ompApp.forgetKey", async () => {
      const app = await forgetKey(context);
      void vscode.window.showInformationMessage(
        app === null
          ? "omp app's address is not set, so no key is kept."
          : "Forgotten. The panel pairs again when it next opens; remove this computer in omp app's Settings → App → Devices too.",
      );
    }),
  );
}

export function deactivate(): void {}
