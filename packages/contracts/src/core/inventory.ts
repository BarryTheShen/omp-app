/**
 * Stable ids for every row of omp's feature inventory (omp's terminal features, grouped by the
 * first 45-module draft).
 *
 * `inventory.json` is generated from that inventory, a Markdown file kept outside this repository,
 * by `scripts/build-inventory.ts`; never edit it by hand. Ids are `<old group>.<slug>` (rules in
 * that script). Descriptors cite the rows they cover, so the W8 audit (CC12) can check that every
 * row is covered exactly once.
 *
 * `rpc` is the status the inventory recorded for the omp version it was generated from (`main`:
 * only on omp's main branch then). What a running omp offers is decided by capabilities, never by
 * this column.
 */
import { z } from "zod";
import inventoryJson from "./inventory.json";

export const INVENTORY_KINDS = [
  "subcommand",
  "command",
  "keybinding",
  "setting-group",
  "message-type",
  "tool-renderer",
  "dialog",
  "status-segment",
  "notification",
  "mode",
  "composer",
  "subagent-view",
  "todo-plan-view",
  "approval",
] as const;
export const InventoryKind = z.enum(INVENTORY_KINDS);
export type InventoryKind = z.infer<typeof InventoryKind>;

export const InventoryRpcStatus = z.enum(["RPC", "main", "terminal-only"]);
export type InventoryRpcStatus = z.infer<typeof InventoryRpcStatus>;

/** `<old group>.<slug>`, for example `T1.read` or `S1.appearance-theme`. */
export type InventoryId = `${string}.${string}`;
export const InventoryId = z.templateLiteral([
  z.string().regex(/^[A-Z][0-9]$/),
  ".",
  z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
]);

export const InventoryItem = z.object({
  id: InventoryId,
  /** The first draft's module id the row was listed under (F1 … S5). */
  group: z.string().regex(/^[A-Z][0-9]$/),
  name: z.string().min(1),
  kind: InventoryKind,
  rpc: InventoryRpcStatus,
  /** The kind of control the research proposed. */
  ui: z.string().min(1),
  /** omp source the row was researched from, as written in the research file. */
  source: z.string().min(1),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

export const INVENTORY: readonly InventoryItem[] = z.array(InventoryItem).parse(inventoryJson);

export const INVENTORY_IDS: ReadonlySet<string> = new Set(INVENTORY.map((item) => item.id));
