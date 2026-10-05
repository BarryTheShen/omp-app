import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isJsonObject, parseSessionContent } from "./parser";
import type { ParseWarning, SubagentTranscript } from "./types";

function isAdvisorTranscriptName(name: string): boolean {
  return name === "__advisor.jsonl" || (name.startsWith("__advisor.") && name.endsWith(".jsonl"));
}

function tombstoneName(transcriptName: string): string {
  return `${transcriptName}.tombstone`;
}

export interface SubagentCollection {
  readonly subagents: readonly SubagentTranscript[];
  readonly parseWarnings: readonly ParseWarning[];
}

interface WalkContext {
  readonly root: string;
  readonly parentKey: string | null;
  readonly output: SubagentTranscript[];
  readonly warnings: ParseWarning[];
}

async function walkSubagentDirectory(context: WalkContext): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(context.root, { withFileTypes: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    context.warnings.push({
      code: "subagent_read_error",
      message: "Unable to read subagent directory",
      sessionFile: context.root,
    });
    return;
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const childDirectories = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );

  for (const name of files) {
    if (!name.endsWith(".jsonl") || name.includes(".bak") || isAdvisorTranscriptName(name))
      continue;
    const agentId = name.slice(0, -".jsonl".length);
    const key = context.parentKey ? `${context.parentKey}/${agentId}` : agentId;
    const sessionFile = path.join(context.root, name);
    let content: string;
    try {
      content = await fs.readFile(sessionFile, "utf8");
    } catch {
      context.warnings.push({
        code: "subagent_read_error",
        message: "Unable to read subagent transcript",
        sessionFile,
      });
      continue;
    }

    const parsed = parseSessionContent(content, sessionFile);
    if (parsed.header) {
      const entriesWithoutHeader = parsed.entries.filter((entry) => {
        return !(isJsonObject(entry) && entry.type === "session");
      });
      const leafEntry = [...entriesWithoutHeader].reverse().find((entry) => {
        return isJsonObject(entry) && typeof entry.id === "string";
      });
      const transcript: SubagentTranscript = {
        key,
        agentId,
        parent: context.parentKey,
        sessionFile,
        path: sessionFile,
        id: parsed.header.id,
        header: parsed.header,
        entries: entriesWithoutHeader,
        leafId:
          leafEntry && isJsonObject(leafEntry) && typeof leafEntry.id === "string"
            ? leafEntry.id
            : null,
        aborted: files.includes(tombstoneName(name)),
        parseWarnings: parsed.parseWarnings,
      };
      context.output.push(transcript);
      context.warnings.push(...parsed.parseWarnings);
    } else if (parsed.parseWarnings.length > 0) {
      context.warnings.push(...parsed.parseWarnings);
    }

    if (childDirectories.has(agentId)) {
      await walkSubagentDirectory({
        root: path.join(context.root, agentId),
        parentKey: key,
        output: context.output,
        warnings: context.warnings,
      });
    }
  }
}

/**
 * Discover nested `<session-stem>/<AgentId>.jsonl` transcripts. Advisor files,
 * backups and symlinked directories are excluded exactly as omp's collector
 * does; tombstones remain visible as `aborted` metadata.
 */
export async function collectSubagentTranscripts(sessionFile: string): Promise<SubagentCollection> {
  if (!sessionFile.endsWith(".jsonl")) return { subagents: [], parseWarnings: [] };
  const output: SubagentTranscript[] = [];
  const warnings: ParseWarning[] = [];
  await walkSubagentDirectory({
    root: sessionFile.slice(0, -".jsonl".length),
    parentKey: null,
    output,
    warnings,
  });
  return { subagents: output, parseWarnings: warnings };
}
