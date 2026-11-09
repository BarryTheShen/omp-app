import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import * as vscode from "vscode";
import type { Reviews } from "./review";
import {
  editedText,
  insideRealRoot,
  KeptOutput,
  matchLines,
  numberedLines,
  type ProjectPath,
  projectPath,
  searchPattern,
} from "./rules";

/** A file larger than this is not read whole nor searched. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

const setting = <T>(name: string, fallback: T): T =>
  vscode.workspace.getConfiguration("ompApp").get<T>(name, fallback);

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`"${name}" is text.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`"${name}" is a number.`);
  return Math.trunc(value);
}

interface FilePath extends ProjectPath {
  readonly uri: vscode.Uri;
}

/** The tools on the folder open in VS Code (`tools.ts` names them), each call checked to stay in the folder. */
export class WorkspaceTools {
  readonly #folder: vscode.WorkspaceFolder;
  readonly #reviews: Reviews;
  readonly #output: vscode.OutputChannel;

  constructor(folder: vscode.WorkspaceFolder, reviews: Reviews, output: vscode.OutputChannel) {
    this.#folder = folder;
    this.#reviews = reviews;
    this.#output = output;
  }

  /** One call: its answer's text; an error's message is the call's error. */
  run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    switch (name) {
      case "vscode_read":
        return this.#read(args);
      case "vscode_list":
        return this.#list(args);
      case "vscode_search":
        return this.#search(args, signal);
      case "vscode_edit":
        return this.#edit(args, signal);
      case "vscode_write":
        return this.#write(args, signal);
      case "vscode_run":
        return this.#run(args, signal);
      case "vscode_problems":
        return this.#problems(args);
      case "vscode_open":
        return this.#open(args);
      default:
        return Promise.reject(new Error(`This panel has no tool named ${name}.`));
    }
  }

  get #root(): string {
    return this.#folder.uri.fsPath;
  }

  /** The path a call names, inside the folder, also after links are followed (as far as the path exists). */
  async #path(asked: unknown, what = "path"): Promise<FilePath> {
    const path = projectPath(this.#root, asked, what);
    const realRoot = await realpath(this.#root);
    for (let probe = path.absolute; ; probe = dirname(probe)) {
      let real: string;
      try {
        real = await realpath(probe);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(probe) === probe)
          throw error;
        continue;
      }
      if (!insideRealRoot(realRoot, real))
        throw new Error(`${path.relative} leads out of the project's folder through a link.`);
      break;
    }
    return { ...path, uri: vscode.Uri.file(path.absolute) };
  }

  /** A file's text: an open editor's (unsaved changes too), else the file's; null when there is no such file. */
  async #text(path: FilePath): Promise<string | null> {
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === path.uri.toString(),
    );
    if (open !== undefined) return open.getText();
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(path.uri);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return null;
      throw error;
    }
    if (stat.type & vscode.FileType.Directory)
      throw new Error(`${path.relative} is a folder, not a file.`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.relative} is larger than 10 MB.`);
    const bytes = await vscode.workspace.fs.readFile(path.uri);
    if (bytes.includes(0)) throw new Error(`${path.relative} is not a text file.`);
    return new TextDecoder().decode(bytes);
  }

  async #read(args: Record<string, unknown>): Promise<string> {
    const path = await this.#path(args.path);
    const content = await this.#text(path);
    if (content === null) throw new Error(`${path.relative} does not exist.`);
    return numberedLines(
      content,
      optionalNumber(args, "start_line"),
      optionalNumber(args, "end_line"),
    );
  }

  async #list(args: Record<string, unknown>): Promise<string> {
    const pattern =
      typeof args.pattern === "string" && args.pattern.trim() !== "" ? args.pattern : "**/*";
    const max = Math.min(2_000, Math.max(1, optionalNumber(args, "max") ?? 500));
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.#folder, pattern),
      undefined,
      max,
    );
    const paths = found.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
    if (paths.length === 0) return `No file matches ${pattern}.`;
    return `${paths.join("\n")}${paths.length === max ? `\n(The first ${max}; narrow the pattern for the rest.)` : ""}`;
  }

  async #search(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const query = text(args, "query");
    const pattern = searchPattern(query, args.literal === true, args.case_sensitive === true);
    const glob = typeof args.glob === "string" && args.glob.trim() !== "" ? args.glob : "**/*";
    const max = Math.min(1_000, Math.max(1, optionalNumber(args, "max") ?? 200));
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.#folder, glob),
      undefined,
      20_000,
    );
    const found: string[] = [];
    for (const uri of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (signal.aborted || found.length >= max) break;
      const relative = vscode.workspace.asRelativePath(uri, false);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
        const content = await this.#text({ absolute: uri.fsPath, relative, uri });
        if (content !== null)
          found.push(...matchLines(relative, content, pattern, max - found.length));
      } catch {
        // A file that is not text, or went away while the search ran.
      }
    }
    if (found.length === 0) return `Nothing in ${glob} matches ${query}.`;
    return `${found.join("\n")}${found.length >= max ? `\n(The first ${max} matches.)` : ""}`;
  }

  /** Whether the change goes ahead: the person's answer, or yes when they let changes go through at once. */
  #accepted(path: string, before: string, after: string, signal: AbortSignal): Promise<boolean> {
    if (!setting("reviewEdits", true)) return Promise.resolve(true);
    return this.#reviews.ask(path, before, after, signal);
  }

  /** Makes the change: an open or existing file through VS Code (its undo keeps it), a new one written. */
  async #apply(path: FilePath, before: string | null, after: string): Promise<void> {
    if (before === null) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(path.absolute)));
      await vscode.workspace.fs.writeFile(path.uri, new TextEncoder().encode(after));
      return;
    }
    // The text the change was made from must still be the file's: the person may have typed meanwhile.
    if ((await this.#text(path)) !== before)
      throw new Error(
        `${path.relative} changed while the change waited; read it again and redo the change.`,
      );
    const document = await vscode.workspace.openTextDocument(path.uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      path.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      after,
    );
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error(`VS Code did not change ${path.relative}.`);
    await document.save();
  }

  async #edit(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const path = await this.#path(args.path);
    const before = await this.#text(path);
    if (before === null)
      throw new Error(`${path.relative} does not exist; vscode_write makes a new file.`);
    const after = editedText(
      before,
      text(args, "old_text"),
      text(args, "new_text"),
      args.replace_all === true,
      path.relative,
    );
    if (!(await this.#accepted(path.relative, before, after, signal)))
      return `The person rejected the change to ${path.relative}; it was not made.`;
    await this.#apply(path, before, after);
    return `Changed ${path.relative}.`;
  }

  async #write(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const path = await this.#path(args.path);
    const content = text(args, "content");
    const before = await this.#text(path);
    if (before === content) return `${path.relative} already holds this text.`;
    if (!(await this.#accepted(path.relative, before ?? "", content, signal)))
      return `The person rejected ${before === null ? "the new file" : "the change to"} ${path.relative}; it was not made.`;
    await this.#apply(path, before, content);
    return before === null ? `Made ${path.relative}.` : `Wrote ${path.relative}.`;
  }

  async #run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const command = text(args, "command").trim();
    if (command === "") throw new Error("Say which command to run.");
    const folder = args.folder === undefined ? null : await this.#path(args.folder, "folder");
    const where = folder?.relative ?? ".";
    if (setting("askBeforeCommands", true)) {
      const choice = await vscode.window.showWarningMessage(
        `omp app wants to run a command in ${where === "." ? "the project's folder" : where}.`,
        { modal: true, detail: command },
        "Run",
      );
      if (choice !== "Run") return "The person did not let this command run.";
    }
    const seconds = Math.min(600, Math.max(1, optionalNumber(args, "timeout_seconds") ?? 120));
    this.#output.appendLine(`$ ${command}    (in ${where})`);
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: folder?.absolute ?? this.#root,
        shell: true,
        detached: process.platform !== "win32",
        env: process.env,
      });
      const kept = new KeptOutput();
      const add = (chunk: Buffer): void => {
        const part = chunk.toString("utf8");
        this.#output.append(part);
        kept.add(part);
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      let stopped: string | null = null;
      const stop = (why: string): void => {
        stopped ??= why;
        try {
          if (child.pid !== undefined && process.platform !== "win32")
            process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // It ended already.
        }
      };
      const timer = setTimeout(() => stop(`stopped after ${seconds} s`), seconds * 1000);
      const onAbort = (): void => stop("stopped: the chat gave the call up");
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (answer: string): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      child.on("error", (error) => done(`The command could not run: ${error.message}`));
      child.on("close", (code, killedBy) => {
        const output = kept.text();
        const ending =
          stopped ?? (code === null ? `ended by ${killedBy ?? "a signal"}` : `exit code ${code}`);
        this.#output.appendLine(`(${ending})`);
        done(`${ending}\n${output === "" ? "(no output)" : output}`);
      });
    });
  }

  async #problems(args: Record<string, unknown>): Promise<string> {
    const one = args.path === undefined ? null : await this.#path(args.path);
    const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] =
      one === null
        ? vscode.languages.getDiagnostics()
        : [[one.uri, vscode.languages.getDiagnostics(one.uri)]];
    const lines: string[] = [];
    for (const [uri, diagnostics] of entries) {
      if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== this.#folder.uri.toString())
        continue;
      const relative = vscode.workspace.asRelativePath(uri, false);
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
        const kind = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
        const at = diagnostic.range.start;
        const source = diagnostic.source === undefined ? "" : ` (${diagnostic.source})`;
        lines.push(
          `${relative}:${at.line + 1}:${at.character + 1} ${kind}: ${diagnostic.message}${source}`,
        );
        if (lines.length >= 300) break;
      }
    }
    if (lines.length === 0)
      return one === null
        ? "VS Code reports no errors or warnings in the project."
        : `No errors or warnings in ${one.relative}.`;
    return lines.join("\n");
  }

  async #open(args: Record<string, unknown>): Promise<string> {
    const path = await this.#path(args.path);
    const line = optionalNumber(args, "line");
    const at = line === undefined ? undefined : new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(path.uri, {
      preview: false,
      ...(at === undefined ? {} : { selection: new vscode.Range(at, at) }),
    });
    return `Opened ${path.relative}${line === undefined ? "" : ` at line ${line}`}.`;
  }
}
