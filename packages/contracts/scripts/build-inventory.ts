/**
 * Builds `src/core/inventory.json` from `research/omp-feature-inventory.md`.
 *
 *   bun scripts/build-inventory.ts        (run in packages/contracts)
 *
 * Every item row (`- [ ] **name** (kind) — … *rpc:* `status` — … *UI:* ui. *Source:* `…``) under a
 * `### <group> <title>` heading becomes `{ id, group, name, kind, rpc, ui, source }`.
 *
 * Ids are `<group>.<slug>`: the name lowercased, a trailing item count such as ` (17)` dropped,
 * and every run of other characters turned into one `-`. When several rows of one group share a
 * slug, each of them gets `-<kind>` appended. The script refuses to write when the row count
 * differs from the count the file states, when a group's rows differ from its "Module map"
 * entry, or when ids collide.
 */
import { join } from "node:path";

export interface InventoryRow {
  id: string;
  group: string;
  name: string;
  kind: string;
  rpc: string;
  ui: string;
  source: string;
}

export const INVENTORY_SOURCE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "research",
  "omp-feature-inventory.md",
);
const TARGET = join(import.meta.dir, "..", "src", "core", "inventory.json");

const GROUP_HEADING = /^### ([A-Z][0-9]) /;
const ITEM =
  /^- \[[ x]\] \*\*(?<name>.+?)\*\* \((?<kind>[a-z-]+)\) — .*? \*rpc:\* `(?<rpc>[^`]+)` — .*? \*UI:\* (?<ui>.*?)\. \*Source:\* `(?<source>[^`]+)`$/;
const STATED_TOTAL = /^Generated .*?\. (\d+) items:/;
const MAP_ROW = /^\| ([A-Z][0-9]) \| .*? \| (\d+) \| \d+ \/ \d+ \/ \d+ \|$/;

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parses the research file; `problems` explains every reason not to trust `rows`. */
export function parseInventory(markdown: string): { rows: InventoryRow[]; problems: string[] } {
  const problems: string[] = [];
  const rows: InventoryRow[] = [];
  const statedPerGroup = new Map<string, number>();
  let statedTotal: number | undefined;
  let group: string | undefined;

  for (const [index, line] of markdown.split("\n").entries()) {
    const total = STATED_TOTAL.exec(line)?.[1];
    if (total !== undefined && statedTotal === undefined) statedTotal = Number(total);
    const mapRow = MAP_ROW.exec(line);
    if (mapRow?.[1] !== undefined) statedPerGroup.set(mapRow[1], Number(mapRow[2]));
    const heading = GROUP_HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      group = heading[1];
      continue;
    }
    if (!line.startsWith("- [")) continue;
    const fields = ITEM.exec(line)?.groups;
    if (group === undefined || fields === undefined) {
      problems.push(`line ${index + 1}: item row does not match the expected format`);
      continue;
    }
    const { name = "", kind = "", rpc = "", ui = "", source = "" } = fields;
    rows.push({ id: `${group}.${slugOf(name)}`, group, name, kind, rpc, ui, source });
  }

  const sharedSlugs = new Map<string, number>();
  for (const row of rows) sharedSlugs.set(row.id, (sharedSlugs.get(row.id) ?? 0) + 1);
  for (const row of rows) if ((sharedSlugs.get(row.id) ?? 0) > 1) row.id = `${row.id}-${row.kind}`;
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    problems.push("ids collide even with the kind suffix");
  }
  if (statedTotal === undefined) problems.push("the file does not state its item count");
  else if (rows.length !== statedTotal) {
    problems.push(`parsed ${rows.length} items, but the file states ${statedTotal}`);
  }
  const perGroup = new Map<string, number>();
  for (const row of rows) perGroup.set(row.group, (perGroup.get(row.group) ?? 0) + 1);
  for (const [mapGroup, stated] of statedPerGroup) {
    const parsed = perGroup.get(mapGroup) ?? 0;
    if (parsed !== stated)
      problems.push(`group ${mapGroup}: parsed ${parsed}, module map states ${stated}`);
  }
  for (const parsedGroup of perGroup.keys()) {
    if (!statedPerGroup.has(parsedGroup))
      problems.push(`group ${parsedGroup} is not in the module map`);
  }
  return { rows, problems };
}

/** The exact text `inventory.json` must contain for these rows. */
export function inventoryJson(rows: readonly InventoryRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

if (import.meta.main) {
  const { rows, problems } = parseInventory(await Bun.file(INVENTORY_SOURCE).text());
  if (problems.length > 0) {
    console.error(`Not writing ${TARGET}:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  await Bun.write(TARGET, inventoryJson(rows));
  console.log(`Wrote ${rows.length} inventory items to ${TARGET}`);
}
