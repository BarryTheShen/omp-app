/**
 * The tools the panel gives its chat, for the project open in VS Code: their names, what they do and their parameters,
 * as omp shows them to the model. The panel declares them (`webview.ts`); the extension runs them (`workspace.ts`). The
 * chat itself runs on omp app's server, in its folder there, with omp's own tools for the server's files; these reach
 * the project on the computer VS Code runs on, and each description says so.
 */
import type { EmbedTool } from "@omp-app/contracts";

const PATH = {
  type: "string",
  description: "A path relative to the folder of the project open in VS Code, such as src/app.ts",
};

const object = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: readonly EmbedTool[] = [
  {
    name: "vscode_read",
    description:
      "Reads a file of the project open in VS Code, on the person's computer (not the server's files, which omp's own tools reach), each line with its number. What an open editor shows is read, unsaved changes too. Give start_line and end_line to read part of a long file.",
    parameters: object(
      {
        path: PATH,
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      ["path"],
    ),
  },
  {
    name: "vscode_list",
    description:
      "Lists the files of the project open in VS Code, on the person's computer, whose paths match a glob pattern (such as src/**/*.ts; all files if left out), the files VS Code's own search leaves out excepted.",
    parameters: object({
      pattern: { type: "string" },
      max: { type: "integer", minimum: 1, maximum: 2000 },
    }),
  },
  {
    name: "vscode_search",
    description:
      "Searches the text files of the project open in VS Code, on the person's computer, for a regular expression (or plain text, with literal) and gives each match as path:line: text. glob narrows the files.",
    parameters: object(
      {
        query: { type: "string" },
        literal: { type: "boolean" },
        case_sensitive: { type: "boolean" },
        glob: { type: "string" },
        max: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["query"],
    ),
  },
  {
    name: "vscode_edit",
    description:
      "Changes a file of the project open in VS Code, on the person's computer: replaces old_text, which must occur exactly once (or every time, with replace_all), with new_text. Copy old_text exactly from vscode_read, without the line numbers. The person sees the change as a diff and accepts or rejects it, unless they let changes go through at once.",
    parameters: object(
      {
        path: PATH,
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean" },
      },
      ["path", "old_text", "new_text"],
    ),
  },
  {
    name: "vscode_write",
    description:
      "Writes a whole file of the project open in VS Code, on the person's computer: a new one, or all of an existing one. Prefer vscode_edit for a change to part of a file. The person sees it as a diff and accepts or rejects it, unless they let changes go through at once.",
    parameters: object({ path: PATH, content: { type: "string" } }, ["path", "content"]),
  },
  {
    name: "vscode_run",
    description:
      "Runs a shell command on the person's computer, in the folder of the project open in VS Code (or in folder, a folder in it), not on the server where omp's own bash runs, and gives its exit code and output (long output is cut in the middle). The person is asked first, unless they let commands run at once. timeout_seconds: 120 if left out, 600 at most.",
    parameters: object(
      {
        command: { type: "string" },
        folder: { type: "string", description: "A folder in the project, relative to it" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 600 },
      },
      ["command"],
    ),
  },
  {
    name: "vscode_problems",
    description:
      "VS Code's errors and warnings (from its language support) in the project open in VS Code: for one file, or for every file of the project that has some.",
    parameters: object({ path: PATH }),
  },
  {
    name: "vscode_open",
    description: "Opens a file of the project in the person's editor, at a line if given.",
    parameters: object({ path: PATH, line: { type: "integer", minimum: 1 } }, ["path"]),
  },
];
