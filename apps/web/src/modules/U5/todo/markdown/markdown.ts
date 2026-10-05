import { AppFailure } from "@omp-app/contracts";
import type { TodoPhase } from "../contract";
import { TodoPhaseSchema } from "../contract";

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;

function invalidMarkdown(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Serializes canonical todo phases to a stable Markdown checklist with phase headings. */
export function exportTodosMarkdown(phases: readonly TodoPhase[]): string {
  const parsed = TodoPhaseSchema.array().safeParse(phases);
  if (!parsed.success) throw invalidMarkdown("Todo phases are malformed.");
  const lines: string[] = [];
  for (const phase of parsed.data) {
    const name = cleanText(phase.name);
    if (name.length === 0) throw invalidMarkdown("Todo phase names cannot be empty.");
    lines.push(`## ${name}`);
    for (const task of phase.tasks) {
      const content = cleanText(task.content);
      if (content.length === 0) throw invalidMarkdown("Todo task content cannot be empty.");
      const checked = task.status === "completed" || task.status === "abandoned" ? "x" : " ";
      lines.push(`- [${checked}] ${content}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Parses phase headings and `- [ ]`/`- [x]` checklist rows into canonical TodoPhase data. */
export function importTodosMarkdown(markdown: string): readonly TodoPhase[] {
  if (typeof markdown !== "string") throw invalidMarkdown("Markdown input must be text.");
  const phases: TodoPhase[] = [];
  let current: TodoPhase | undefined;
  for (const [lineNumber, rawLine] of markdown.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) continue;
    const heading = line.match(HEADING);
    if (heading) {
      const name = cleanText(heading[2] ?? "");
      if (name.length === 0)
        throw invalidMarkdown(`Markdown phase heading ${lineNumber + 1} is empty.`);
      current = { name, tasks: [] };
      phases.push(current);
      continue;
    }
    const task = line.match(TASK);
    if (task) {
      if (!current) {
        throw invalidMarkdown(`Markdown task ${lineNumber + 1} appears before a phase heading.`);
      }
      const content = cleanText(task[2] ?? "");
      if (content.length === 0) throw invalidMarkdown(`Markdown task ${lineNumber + 1} is empty.`);
      current.tasks.push({
        content,
        status: task[1]?.toLowerCase() === "x" ? "completed" : "pending",
      });
      continue;
    }
    throw invalidMarkdown(`Unsupported Markdown todo syntax on line ${lineNumber + 1}.`);
  }
  return TodoPhaseSchema.array().parse(phases);
}

export function copyTodosMarkdown(phases: readonly TodoPhase[]): string {
  return exportTodosMarkdown(phases);
}
