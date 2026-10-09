/**
 * omp ends a branch or compaction summary with a `<files>` block: the files the work read and changed,
 * as a path tree (`packages/agent/src/compaction/utils.ts`, `packages/utils/src/path-tree.ts`):
 *
 *     <files>
 *     # src/
 *     parser.ts (Read)
 *     store.ts (RW)
 *     # src/lib/
 *     hash.ts (Write)
 *     </files>
 *
 * Each directory is a `#` header with one more `#` per level, each file is its bare name with a
 * ` (Read)`, ` (Write)` or ` (RW)` marker, and `[…N files elided…]` counts the files omp left out.
 * U1's Markdown renders no raw HTML, so the block vanished from every summary.
 * `summaryWithFileLists` rewrites each block as two plain Markdown lists, "Files read" and "Files
 * changed". A file read and then changed (RW) is listed under "Files changed" only.
 */

const FILES_BLOCK = /<files>\s*([\s\S]*?)\s*<\/files>/g;
const DIRECTORY_HEADER = /^(#+) (.+)\/$/;
const FILE_LINE = /^(.+) \((Read|Write|RW)\)$/;
const ELIDED_LINE = /^\[…(\d+) files elided…\]$/;

export interface SummaryFileList {
  readonly read: readonly string[];
  readonly changed: readonly string[];
  /** How many files omp left out of the block. */
  readonly elided: number;
}

/** The inside of one `<files>` block as full paths; a file belongs to the nearest directory header above it. */
export function parseFileList(block: string): SummaryFileList {
  const read: string[] = [];
  const changed: string[] = [];
  const directories: string[] = [];
  let elided = 0;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") continue;
    const elision = ELIDED_LINE.exec(line.trim());
    if (elision) {
      elided += Number(elision[1]);
      continue;
    }
    const header = DIRECTORY_HEADER.exec(line);
    if (header) {
      directories.splice((header[1] ?? "").length - 1);
      directories.push(header[2] ?? "");
      continue;
    }
    const file = FILE_LINE.exec(line);
    const path = [...directories, file?.[1] ?? line].join("/");
    if (file?.[2] === "Write" || file?.[2] === "RW") changed.push(path);
    else read.push(path);
  }
  return { read, changed, elided };
}

/** A file name as Markdown code, fenced longer than any backtick run the name holds. */
function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function listMarkdown(heading: string, paths: readonly string[]): string {
  return `**${heading}**\n\n${paths.map((path) => `- ${codeSpan(path)}`).join("\n")}`;
}

function markdownFor(list: SummaryFileList): string {
  const sections: string[] = [];
  if (list.read.length > 0) sections.push(listMarkdown("Files read", list.read));
  if (list.changed.length > 0) sections.push(listMarkdown("Files changed", list.changed));
  if (list.elided > 0) sections.push(`${list.elided} more files not listed.`);
  return sections.join("\n\n");
}

/**
 * The summary text with each `<files>` block replaced by plain Markdown lists, so a person reads the
 * file names and no raw tag reaches U1's Markdown. Text outside the blocks is unchanged.
 */
export function summaryWithFileLists(summary: string): string {
  return summary.replace(FILES_BLOCK, (_block: string, inside: string) =>
    markdownFor(parseFileList(inside)),
  );
}
