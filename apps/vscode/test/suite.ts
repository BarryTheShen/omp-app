/**
 * Runs inside VS Code (`test/run.ts` starts it on a throwaway folder): the panel's tools on the open folder through
 * VS Code's own API, a change's review in VS Code's diff, and the side bar's panel framing a stand-in for omp app
 * that sends the app's frame rule and speaks the embed protocol. VS Code calls `run`; a rejected promise fails it.
 */
import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { editorContext } from "../src/panel";
import { REVIEW_SCHEME, Reviews } from "../src/review";
import { WorkspaceTools } from "../src/workspace";

/**
 * omp app's lite view as a stand-in: the frame rule the app sends when VS Code's switch is on (Settings → App →
 * Integrations), and the protocol's steps: it listens, hands over a key, says which chat it shows, and calls a tool.
 * What the panel sends back it posts to `/seen`.
 */
const STAND_IN = `<!doctype html><script>
const seen = (what, data) => fetch("/seen", { method: "POST", body: JSON.stringify({ what, data }) });
const say = (body) => parent.postMessage({ omp: "embed", v: 1, ...body }, "*");
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.omp !== "embed") return;
  seen(message.type, message);
  if (message.type === "hello" && message.credential === undefined) {
    say({ type: "credential", key: "stand-in-key-0123456789abcdef" });
    say({ type: "ready", chat: "stand-in-chat", tools: message.tools.map((tool) => tool.name) });
    say({ type: "tool_call", callId: "call-1", name: "vscode_read", arguments: { path: "README.md" } });
  }
});
say({ type: "listening" });
</script>`;

interface Seen {
  readonly what: string;
  readonly data: Record<string, unknown>;
}

async function until(check: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Waited ${ms} ms for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The diff tabs of changes waiting for an answer. */
const reviewTabs = (): vscode.Tab[] =>
  vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === REVIEW_SCHEME,
    ),
  );

const activeIsReview = (): boolean => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff && input.modified.scheme === REVIEW_SCHEME;
};

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "VS Code opened the test's folder");
  const root = folder.uri.fsPath;
  await writeFile(join(root, "README.md"), "# Demo\nline two\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/app.ts"), "export const a = 1;\nexport const b = 2;\n");
  await writeFile(join(root, "broken.json"), '{ "a": 1, }\n');
  await symlink("/etc", join(root, "outside"));

  const config = vscode.workspace.getConfiguration("ompApp");
  await config.update("reviewEdits", false, vscode.ConfigurationTarget.Global);
  await config.update("askBeforeCommands", false, vscode.ConfigurationTarget.Global);

  const reviews = new Reviews();
  const tools = new WorkspaceTools(
    folder,
    reviews,
    vscode.window.createOutputChannel("omp app test"),
  );
  const call = (
    name: string,
    args: Record<string, unknown>,
    signal = new AbortController().signal,
  ) => tools.run(name, args, signal);

  // The extension started: its view and commands are there.
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "ompApp.openInEditor",
    "ompApp.acceptChange",
    "ompApp.rejectChange",
    "ompApp.forgetKey",
  ])
    assert.ok(commands.includes(command), `${command} is registered`);

  // Reading: numbered lines; what an open editor holds, unsaved changes too.
  assert.equal(await call("vscode_read", { path: "README.md" }), "1\t# Demo\n2\tline two");
  const readme = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "README.md")));
  const unsaved = new vscode.WorkspaceEdit();
  unsaved.insert(readme.uri, new vscode.Position(2, 0), "unsaved line\n");
  assert.ok(await vscode.workspace.applyEdit(unsaved));
  assert.equal(await call("vscode_read", { path: "README.md", start_line: 3 }), "3\tunsaved line");
  // Back to the file as saved: VS Code's revert works on the active editor.
  await vscode.window.showTextDocument(readme);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  assert.equal(readme.isDirty, false);

  // Listing and searching through VS Code's search.
  assert.equal(await call("vscode_list", { pattern: "**/*.ts" }), "src/app.ts");
  assert.equal(
    await call("vscode_search", { query: "const b" }),
    "src/app.ts:2: export const b = 2;",
  );
  assert.equal(
    await call("vscode_search", { query: "nothing like this" }),
    "Nothing in **/* matches nothing like this.",
  );

  // Outside the folder: by path, and through a link.
  await assert.rejects(
    call("vscode_read", { path: "../elsewhere.txt" }),
    /outside the project's folder/,
  );
  await assert.rejects(
    call("vscode_read", { path: "outside/hostname" }),
    /leads out of the project's folder/,
  );
  await assert.rejects(call("vscode_read", { path: "missing.txt" }), /does not exist/);

  // A change made at once, when the person lets changes through.
  assert.equal(
    await call("vscode_edit", { path: "src/app.ts", old_text: "b = 2", new_text: "b = 3" }),
    "Changed src/app.ts.",
  );
  assert.equal(
    await readFile(join(root, "src/app.ts"), "utf8"),
    "export const a = 1;\nexport const b = 3;\n",
  );
  assert.equal(
    await call("vscode_write", { path: "src/new/made.ts", content: "made\n" }),
    "Made src/new/made.ts.",
  );
  assert.equal(await readFile(join(root, "src/new/made.ts"), "utf8"), "made\n");
  await assert.rejects(
    call("vscode_edit", { path: "src/app.ts", old_text: "export", new_text: "x" }),
    /occurs 2 times/,
  );
  // A file of mixed line endings, which VS Code evens out when it opens one: the change is still made.
  await writeFile(join(root, "mixed.txt"), "one\r\ntwo\nthree\r\n");
  assert.equal(
    await call("vscode_edit", { path: "mixed.txt", old_text: "two", new_text: "2" }),
    "Changed mixed.txt.",
  );
  assert.match(await readFile(join(root, "mixed.txt"), "utf8"), /^one\r?\n2\r?\nthree\r?\n$/);

  // Reviewed: the diff opens; accepted, the change is made and saved; the diff closes.
  await config.update("reviewEdits", true, vscode.ConfigurationTarget.Global);
  const accepted = call("vscode_edit", {
    path: "src/app.ts",
    old_text: "a = 1",
    new_text: "a = 5",
  });
  await until(activeIsReview, "the change's diff");
  reviews.decideActive(true);
  assert.equal(await accepted, "Changed src/app.ts.");
  assert.equal(
    await readFile(join(root, "src/app.ts"), "utf8"),
    "export const a = 5;\nexport const b = 3;\n",
  );
  await until(() => reviewTabs().length === 0, "the diff to close");

  // Rejected: nothing changes, and the model is told.
  const rejected = call("vscode_write", { path: "src/rejected.ts", content: "no\n" });
  await until(activeIsReview, "the new file's diff");
  reviews.decideActive(false);
  assert.equal(
    await rejected,
    "The person rejected the new file src/rejected.ts; it was not made.",
  );
  assert.equal(existsSync(join(root, "src/rejected.ts")), false);

  // omp giving the call up closes the diff and changes nothing.
  const controller = new AbortController();
  const givenUp = call(
    "vscode_edit",
    { path: "src/app.ts", old_text: "b = 3", new_text: "b = 4" },
    controller.signal,
  );
  await until(activeIsReview, "the third diff");
  controller.abort();
  await givenUp;
  await until(() => reviewTabs().length === 0, "the given-up diff to close");
  assert.equal(
    await readFile(join(root, "src/app.ts"), "utf8"),
    "export const a = 5;\nexport const b = 3;\n",
  );

  // Commands: run in the folder, with the exit code and output; stopped when the call is given up.
  assert.equal(await call("vscode_run", { command: "echo hi; exit 3" }), "exit code 3\nhi\n");
  assert.match(
    await call("vscode_run", { command: "head -c 100000 /dev/zero | tr '\\0' x" }),
    /^exit code 0\nx{20000}\n… \(20000 characters cut\) …\nx{60000}$/,
  );
  assert.equal(
    await call("vscode_run", { command: "pwd", folder: "src" }),
    `exit code 0\n${join(root, "src")}\n`,
  );
  const stopping = new AbortController();
  const long = call("vscode_run", { command: "sleep 30" }, stopping.signal);
  setTimeout(() => stopping.abort(), 300);
  assert.match(await long, /^stopped: the chat gave the call up/);

  // VS Code's errors, from its JSON support, and opening a file at a line.
  await vscode.window.showTextDocument(vscode.Uri.file(join(root, "broken.json")));
  await until(
    () => vscode.languages.getDiagnostics(vscode.Uri.file(join(root, "broken.json"))).length > 0,
    "VS Code's JSON errors",
  );
  assert.match(
    await call("vscode_problems", { path: "broken.json" }),
    /^broken\.json:1:\d+ (error|warning): /,
  );
  assert.equal(
    await call("vscode_open", { path: "README.md", line: 2 }),
    "Opened README.md at line 2.",
  );
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, join(root, "README.md"));
  assert.equal(vscode.window.activeTextEditor?.selection.active.line, 1);

  // What goes with each message (`editorContext`): the open file and the selected lines; in a notebook, the cell and
  // the lines selected in it, also once the focus has gone to the side bar, where the person types; a preview's name.
  const same = (expected: unknown): boolean =>
    JSON.stringify(editorContext()) === JSON.stringify(expected);
  const appEditor = await vscode.window.showTextDocument(vscode.Uri.file(join(root, "src/app.ts")));
  appEditor.selection = new vscode.Selection(1, 0, 1, 6);
  await until(
    () => same({ kind: "file", title: "src/app.ts", uri: "src/app.ts#L2-2", selection: "export" }),
    "the file's line in the context",
  );
  const cellCode = ["x = 1\n", "y = 2\n", "z = 3"];
  await writeFile(
    join(root, "demo.ipynb"),
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: ["a = 1\n"],
          metadata: {},
          outputs: [],
          execution_count: null,
        },
        { cell_type: "code", source: cellCode, metadata: {}, outputs: [], execution_count: null },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );
  const notebook = await vscode.workspace.openNotebookDocument(
    vscode.Uri.file(join(root, "demo.ipynb")),
  );
  // Cell 2 chosen, and its editor entered as a click into the cell does (VS Code's own command).
  await vscode.window.showNotebookDocument(notebook, {
    selections: [new vscode.NotebookRange(1, 2)],
  });
  await vscode.commands.executeCommand("notebook.cell.edit");
  const cellDocument = notebook.cellAt(1).document;
  await until(
    () => vscode.window.visibleTextEditors.some((editor) => editor.document === cellDocument),
    "the cell's editor",
  );
  const cellEditor =
    vscode.window.activeTextEditor?.document === cellDocument
      ? vscode.window.activeTextEditor
      : vscode.window.visibleTextEditors.find((editor) => editor.document === cellDocument);
  assert.ok(cellEditor, "the cell's editor");
  cellEditor.selection = new vscode.Selection(0, 0, 1, 5);
  const cellLines = {
    kind: "notebook",
    title: "demo.ipynb, cell 2",
    uri: "demo.ipynb#cell2-L1-2",
    selection: "x = 1\ny = 2",
  };
  await until(() => same(cellLines), "the notebook's cell and lines in the context");
  await vscode.commands.executeCommand("workbench.view.explorer");
  await new Promise((done) => setTimeout(done, 500));
  assert.deepEqual(editorContext(), cellLines, "the same once the side bar has the focus");
  cellEditor.selection = new vscode.Selection(2, 0, 2, 0);
  await until(
    () =>
      same({
        kind: "notebook",
        title: "demo.ipynb, cell 2",
        uri: "demo.ipynb#cell2",
        text: cellCode.join(""),
      }),
    "the cell's text when nothing is selected",
  );
  await vscode.window.showTextDocument(vscode.Uri.file(join(root, "README.md")));
  await vscode.commands.executeCommand("markdown.showPreview");
  await until(
    () => same({ kind: "view", title: "Preview README.md" }),
    "the preview's name in the context",
  );
  // Back to README.md alone, the file the panel's part below expects open.
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.window.showTextDocument(vscode.Uri.file(join(root, "README.md")));

  // The side bar's panel frames the app (here the stand-in) under its frame rule, and speaks the protocol.
  const seen: Seen[] = [];
  const loads: string[] = [];
  const app = createServer((request, response) => {
    if (request.url === "/seen") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        seen.push(JSON.parse(body) as Seen);
        response.end();
      });
      return;
    }
    loads.push(request.url ?? "");
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": "frame-ancestors vscode-webview: vscode-file:",
    });
    response.end(STAND_IN);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await config.update("address", origin, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.view.extension.ompApp");
    const hello = (credential: boolean) => () =>
      seen.some(
        ({ what, data }) => what === "hello" && (data.credential !== undefined) === credential,
      );
    await until(hello(false), "the panel's hello", 60_000);
    const first = seen.find(({ what }) => what === "hello")?.data ?? {};
    assert.equal(first.host, "vscode");
    assert.equal((first.files as { project: string }).project, "project");
    assert.match((first.files as { id: string }).id, /^[a-f0-9]{16}$/);
    assert.deepEqual(
      (first.tools as { name: string }[]).map((tool) => tool.name),
      [
        "vscode_read",
        "vscode_list",
        "vscode_search",
        "vscode_edit",
        "vscode_write",
        "vscode_run",
        "vscode_problems",
        "vscode_open",
      ],
    );
    assert.deepEqual(first.context, { kind: "file", title: "README.md", uri: "README.md" });

    // The tool's call went to the extension, which read the open folder.
    await until(() => seen.some(({ what }) => what === "tool_result"), "the tool's answer", 30_000);
    assert.deepEqual(seen.find(({ what }) => what === "tool_result")?.data.result, {
      content: [{ type: "text", text: "1\t# Demo\n2\tline two" }],
    });

    // Loaded again (the address changed): the key comes from VS Code's keeping, and the chat it showed opens again.
    await config.update("address", `${origin}/`, vscode.ConfigurationTarget.Global);
    await until(hello(true), "the second hello, with the key", 60_000);
    assert.equal(
      seen.find(({ what, data }) => what === "hello" && data.credential !== undefined)?.data
        .credential,
      "stand-in-key-0123456789abcdef",
    );
    assert.ok(
      loads.at(-1)?.includes("stand-in-chat"),
      `the second load asks for the chat: ${loads.at(-1)}`,
    );
  } finally {
    app.closeAllConnections();
    app.close();
  }
}
