import type { EntryId, ThreadId } from "@omp-app/contracts";
import { useCallback, useSyncExternalStore } from "react";
import { P3MessageActions } from "@/modules/P3/runs";
import type { OmpRuntimeStore, RuntimeSnapshot } from "@/modules/R0/store";
import type { LastUserVersions } from "./use-other-versions";

/** The records of one store snapshot by row id, each with its saved entry: the answer `storedEntryId` gives, built once per snapshot. */
const savedEntryIndexes = new WeakMap<RuntimeSnapshot, ReadonlyMap<string, EntryId | undefined>>();

function savedEntryIndex(snapshot: RuntimeSnapshot): ReadonlyMap<string, EntryId | undefined> {
  const cached = savedEntryIndexes.get(snapshot);
  if (cached !== undefined) return cached;
  const index = new Map<string, EntryId | undefined>();
  for (const key of snapshot.messageOrder) {
    const record = snapshot.messages[key];
    if (record === undefined) continue;
    if (!index.has(record.key)) index.set(record.key, record.entryId);
    if (record.rowKey !== undefined && !index.has(record.rowKey)) {
      index.set(record.rowKey, record.entryId);
    }
  }
  savedEntryIndexes.set(snapshot, index);
  return index;
}

/** The entry the store saved for one row, or null. Read at each store change, so a row sees an entry saved after it was drawn. */
function savedEntryOf(snapshot: RuntimeSnapshot, rowId: string): EntryId | null {
  const entryId = savedEntryIndex(snapshot).get(rowId);
  return entryId !== undefined && snapshot.transcript.entries[entryId] !== undefined
    ? entryId
    : null;
}

/**
 * One row's actions. The row's saved entry is read from the store at each change, so an entry saved after the row was
 * drawn shows its actions at once, and the row itself is not drawn again for it. The version switcher is read from the
 * chat's last user message (see `createLastUserVersions`).
 */
export function RowActions({
  rowId,
  role,
  store,
  versions,
  onEdit,
  onOpenOtherVersion,
}: {
  readonly rowId: string;
  readonly role: string;
  readonly store: OmpRuntimeStore;
  readonly versions: LastUserVersions;
  readonly onEdit: (entryId: EntryId, trigger: HTMLButtonElement) => void;
  readonly onOpenOtherVersion: (threadId: ThreadId) => void;
}) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const entryId = useSyncExternalStore(subscribe, () => savedEntryOf(store.getSnapshot(), rowId));
  const otherVersions = useSyncExternalStore(versions.subscribe, () =>
    entryId === null ? undefined : versions.versionsFor(entryId),
  );
  if (entryId === null) return null;
  return (
    <P3MessageActions
      onEdit={role === "user" ? (trigger) => onEdit(entryId, trigger) : undefined}
      onOpenOtherVersion={onOpenOtherVersion}
      otherVersions={otherVersions}
    />
  );
}
