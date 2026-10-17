import { AppFailure, type MemoryEntry, type MemoryScope, type ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStableOverlayHost } from "@/overlay";
import { openDestructiveCommandConfirm } from "../../U4/dialogs/confirm-destructive-command";
import type { MemoryScopeSelection, MemoryStoreAdapter } from "../ports";
import {
  DESTRUCTIVE_MEMORY_COMMANDS,
  MEMORY_COMMAND_LABELS,
  type MemoryCommand,
  type MemoryCommandExecutor,
  type MemoryCommandResult,
  normalizeMemoryCommand,
  requiresMemoryCommandExecutor,
} from "./commands";

export interface MemoryCenterOptions {
  readonly adapter: MemoryStoreAdapter;
  readonly folder: MemoryScopeSelection["folder"];
  readonly threadId: ThreadId;
  readonly scope?: MemoryScope;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly runCommand?: MemoryCommandExecutor;
}

export interface MemoryCenterState {
  readonly open: boolean;
  readonly scope: MemoryScope;
  readonly entries: readonly MemoryEntry[];
  readonly selected: MemoryEntry | undefined;
  readonly draft: string;
  readonly draftDirty: boolean;
  readonly draftConflict: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly revision: string | null;
  readonly error: AppFailure | null;
  readonly errorAction: "load" | "save" | "delete" | null;
  readonly command: MemoryCommandResult | null;
  readonly canEdit: boolean;
  readonly commandGatewayAvailable: boolean;
  readonly unavailableReason?: string;
}

export interface MemoryCenterController {
  readonly state: MemoryCenterState;
  readonly actions: {
    readonly open: () => void;
    readonly close: () => void;
    readonly setScope: (scope: MemoryScope) => Promise<void>;
    readonly select: (id: string | undefined) => Promise<void>;
    readonly setDraft: (draft: string) => void;
    readonly reloadDraft: () => Promise<void>;
    readonly keepDraft: () => void;
    readonly refresh: () => Promise<void>;
    readonly save: () => Promise<void>;
    readonly remove: () => Promise<void>;
    readonly runCommand: (command: MemoryCommand) => Promise<void>;
  };
}

function failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({ code: "internal", message: fallback, retryable: true });
}

function confirmationText(
  command: MemoryCommand,
  scope: MemoryScope,
): {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
} {
  if (command === "mm-seed") {
    return {
      title: "Add missing mental models?",
      description: `This adds built-in mental models that are missing from the ${scope} scope.`,
      confirmLabel: "Add mental models",
    };
  }
  return {
    title: "Clear memory?",
    description: `This removes stored memory from the ${scope} scope.`,
    confirmLabel: "Clear memory",
  };
}
function clearCompletionMessage(command: MemoryCommand, deletedCount: number): string {
  const label = MEMORY_COMMAND_LABELS[command];
  if (deletedCount === 0) return `${label} completed.`;
  return `${label} completed. Removed ${deletedCount} memory item${deletedCount === 1 ? "" : "s"}.`;
}

export function useMemoryCenter({
  adapter,
  folder,
  threadId,
  scope: initialScope = "project",
  open: initiallyOpen = false,
  onOpenChange,
  runCommand,
}: MemoryCenterOptions): MemoryCenterController {
  const [open, setOpen] = useState(initiallyOpen);
  const [scope, setScope] = useState<MemoryScope>(initialScope);
  const overlay = useStableOverlayHost();
  const [entries, setEntries] = useState<readonly MemoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [error, setError] = useState<AppFailure | null>(null);
  const [errorAction, setErrorAction] = useState<"load" | "save" | "delete" | null>(null);
  const [command, setCommand] = useState<MemoryCommandResult | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const draftRef = useRef("");
  const draftDirtyRef = useRef(false);
  const revisionRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const selected = entries.find((entry) => entry.id === selectedId);
  const canEdit = Boolean(adapter);

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const confirmDraftDiscard = useCallback(async () => {
    if (!draftDirtyRef.current) return true;
    return openDestructiveCommandConfirm(
      { open: (options) => overlay.open(options) },
      {
        label: "Discard draft",
        title: "Discard unsaved changes?",
        description: "Your unsaved memory changes will be lost.",
        confirmLabel: "Discard draft",
      },
    );
  }, [overlay]);

  const refresh = useCallback(
    async (preserveError = false): Promise<boolean> => {
      loadAbort.current?.abort();
      const abort = new AbortController();
      loadAbort.current = abort;
      setLoading(true);
      if (!preserveError) {
        setError(null);
        setErrorAction(null);
      }
      try {
        const result = await adapter.list({ folder, scope, threadId }, { signal: abort.signal });
        if (abort.signal.aborted) return false;
        if (!result.parsed) {
          if (!preserveError) {
            setError(
              failure(new Error("unparsed"), "Memory is not available in a readable form yet."),
            );
            setErrorAction("load");
          }
          return false;
        }
        const revisionChanged =
          revisionRef.current !== null && revisionRef.current !== result.revision;
        revisionRef.current = result.revision;
        setEntries(result.entries);
        setRevision(result.revision);
        const nextSelectedId = result.entries.some((entry) => entry.id === selectedIdRef.current)
          ? selectedIdRef.current
          : undefined;
        selectedIdRef.current = nextSelectedId;
        setSelectedId(nextSelectedId);
        const nextEntry = result.entries.find((entry) => entry.id === nextSelectedId);
        if (draftDirtyRef.current) {
          if (revisionChanged) setDraftConflict(true);
        } else {
          const nextDraft = nextEntry?.content ?? "";
          draftRef.current = nextDraft;
          setDraft(nextDraft);
          setDraftDirty(false);
          setDraftConflict(false);
        }
        return true;
      } catch (cause) {
        if (!abort.signal.aborted && !preserveError) {
          setError(failure(cause, "Memory could not be loaded. Try again."));
          setErrorAction("load");
        }
        return false;
      } finally {
        if (loadAbort.current === abort) loadAbort.current = null;
        if (!abort.signal.aborted) setLoading(false);
      }
    },
    [adapter, folder, scope, threadId],
  );

  useEffect(() => {
    if (!open) return;
    void refresh();
    return () => {
      loadAbort.current?.abort();
      actionAbort.current?.abort();
      setLoading(false);
      setSaving(false);
      setDeleting(false);
      setCommand((current) => (current?.status === "pending" ? null : current));
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const unsubscribe = adapter.subscribeChanged({ scope, folder }, () => {
      void refresh();
    });
    return unsubscribe;
  }, [adapter, folder, open, refresh, scope]);

  const select = useCallback(
    async (id: string | undefined) => {
      if (id === selectedIdRef.current || !(await confirmDraftDiscard())) return;
      const entry = entries.find((candidate) => candidate.id === id);
      selectedIdRef.current = id;
      setSelectedId(id);
      draftRef.current = entry?.content ?? "";
      setDraft(draftRef.current);
      draftDirtyRef.current = false;
      setDraftDirty(false);
      setDraftConflict(false);
      setError(null);
      setErrorAction(null);
    },
    [confirmDraftDiscard, entries],
  );

  const updateDraft = useCallback(
    (next: string) => {
      setDraft(next);
      draftRef.current = next;
      draftDirtyRef.current = selected !== undefined && next !== selected.content;
      setDraftDirty(draftDirtyRef.current);
    },
    [selected],
  );
  const reloadDraft = useCallback(async () => {
    draftDirtyRef.current = false;
    setDraftDirty(false);
    setDraftConflict(false);
    await refresh();
  }, [refresh]);

  const keepDraft = useCallback(() => {
    setDraftConflict(false);
  }, []);

  const save = useCallback(async () => {
    if (!selected || saving) return;
    const abort = new AbortController();
    actionAbort.current = abort;
    setSaving(true);
    setError(null);
    setErrorAction(null);
    try {
      const result = await adapter.write(
        {
          folder,
          scope,
          threadId,
          id: selected.id,
          content: draftRef.current,
          metadata: selected.metadata,
          sensitive: selected.sensitive,
          expectedRevision: revision,
        },
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      if (!result.parsed || result.entry === null) {
        setError(failure(new Error("unparsed"), "Memory could not be saved. Try again."));
        setErrorAction("save");
        return;
      }
      revisionRef.current = result.revision;
      setRevision(result.revision);
      setEntries((current) =>
        current.map((entry) => (entry.id === result.entry?.id ? result.entry : entry)),
      );
      draftRef.current = result.entry.content;
      setDraft(result.entry.content);
      draftDirtyRef.current = false;
      setDraftDirty(false);
      setDraftConflict(false);
      setError(null);
      setErrorAction(null);
    } catch (cause) {
      if (!abort.signal.aborted) {
        const next = failure(cause, "Memory could not be saved. Your draft is still here.");
        if (next.appError.code === "conflict") await refresh(true);
        if (!abort.signal.aborted) {
          setError(next);
          setErrorAction("save");
          setDraftConflict(next.appError.code === "conflict");
        }
      }
    } finally {
      if (actionAbort.current === abort) actionAbort.current = null;
      if (!abort.signal.aborted) setSaving(false);
    }
  }, [adapter, folder, refresh, revision, saving, scope, selected, threadId]);

  const remove = useCallback(async () => {
    if (!selected || deleting) return;
    const confirmed = await openDestructiveCommandConfirm(
      { open: (options) => overlay.open(options) },
      {
        label: "Delete memory",
        title: "Delete this memory?",
        description: `This removes the selected memory from the ${scope} scope.`,
        confirmLabel: "Delete memory",
      },
    );
    if (!confirmed) return;
    const abort = new AbortController();
    actionAbort.current = abort;
    setDeleting(true);
    setError(null);
    setErrorAction(null);
    try {
      const result = await adapter.delete(
        { folder, scope, threadId, id: selected.id, confirmed: true, expectedRevision: revision },
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      if (!result.parsed) {
        setError(failure(new Error("unparsed"), "Memory could not be deleted. Try again."));
        setErrorAction("delete");
        return;
      }
      selectedIdRef.current = undefined;
      setSelectedId(undefined);
      draftRef.current = "";
      setDraft("");
      draftDirtyRef.current = false;
      setDraftDirty(false);
      revisionRef.current = result.revision;
      setRevision(result.revision);
      setError(null);
      setErrorAction(null);
      await refresh();
    } catch (cause) {
      if (!abort.signal.aborted) {
        setError(failure(cause, "Memory could not be deleted. Try again."));
        setErrorAction("delete");
      }
    } finally {
      if (actionAbort.current === abort) actionAbort.current = null;
      if (!abort.signal.aborted) setDeleting(false);
    }
  }, [adapter, deleting, folder, overlay, refresh, revision, scope, selected, threadId]);

  const executeCommand = useCallback(
    async (requested: MemoryCommand) => {
      const normalized = normalizeMemoryCommand(requested);
      const directClear = requested === "clear" || requested === "reset" ? requested : undefined;
      if (!runCommand && requiresMemoryCommandExecutor(requested)) {
        setCommand({
          command: requested,
          status: "error",
          message: "This action needs typed support from omp and is unavailable here.",
        });
        return;
      }
      if (DESTRUCTIVE_MEMORY_COMMANDS.has(requested)) {
        const text = confirmationText(requested, scope);
        const confirmed = await openDestructiveCommandConfirm(
          { open: (options) => overlay.open(options) },
          { label: text.confirmLabel, ...text },
        );
        if (!confirmed) return;
      }
      const abort = new AbortController();
      actionAbort.current = abort;
      setCommand({ command: requested, status: "pending", message: "Working on memory…" });
      setError(null);
      setErrorAction(null);
      try {
        if (directClear !== undefined) {
          const result = await adapter.clear(
            {
              folder,
              scope,
              threadId,
              operation: directClear,
              confirmed: true,
              expectedRevision: revision,
            },
            { signal: abort.signal },
          );
          if (abort.signal.aborted) return;
          if (!result.parsed) {
            const error = failure(
              new Error("unparsed"),
              "omp returned a memory result the app could not read.",
            );
            setCommand({
              command: requested,
              status: "error",
              message: error.appError.message,
              error,
            });
            return;
          }
          revisionRef.current = result.revision;
          setRevision(result.revision);
          setCommand({
            command: requested,
            status: "complete",
            message: clearCompletionMessage(requested, result.deletedCount),
          });
          await refresh();
        } else if (requested === "mm-list") {
          const refreshed = await refresh();
          if (!abort.signal.aborted) {
            setCommand(
              refreshed
                ? {
                    command: requested,
                    status: "complete",
                    message: `${MEMORY_COMMAND_LABELS[requested]} updated.`,
                  }
                : {
                    command: requested,
                    status: "error",
                    message: "Saved memory could not be loaded.",
                  },
            );
          }
        } else if (requested === "mm-show") {
          if (!selected) {
            setCommand({
              command: requested,
              status: "error",
              message: "Select a saved memory item first.",
            });
            return;
          }
          const result = await adapter.get(
            { folder, scope, threadId, id: selected.id },
            { signal: abort.signal },
          );
          if (abort.signal.aborted) return;
          if (!result.parsed || result.entry === null) {
            const error = failure(new Error("unparsed"), "Saved memory details could not be read.");
            setCommand({
              command: requested,
              status: "error",
              message: error.appError.message,
              error,
            });
            return;
          }
          setEntries((current) =>
            current.map((entry) => (entry.id === result.entry?.id ? result.entry : entry)),
          );
          if (!draftDirtyRef.current) {
            draftRef.current = result.entry.content;
            setDraft(result.entry.content);
          }
          setCommand({
            command: requested,
            status: "complete",
            message: `${MEMORY_COMMAND_LABELS[requested]} completed.`,
          });
        } else if (runCommand) {
          const result = await runCommand(
            { command: normalized, scope, memoryId: selectedId },
            { signal: abort.signal },
          );
          if (!abort.signal.aborted) {
            setCommand({
              ...result,
              command: requested,
              message:
                result.message ??
                (result.status === "pending"
                  ? "Working on memory…"
                  : result.status === "complete"
                    ? `${MEMORY_COMMAND_LABELS[requested]} completed.`
                    : (result.error?.appError.message ?? "The memory command failed.")),
            });
            if (result.status === "complete") await refresh();
          }
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          const error = failure(cause, "The memory command failed. Try again.");
          setCommand({
            command: requested,
            status: "error",
            message: error.appError.message,
            error,
          });
        }
      } finally {
        if (actionAbort.current === abort) actionAbort.current = null;
      }
    },
    [
      adapter,
      folder,
      overlay,
      refresh,
      revision,
      runCommand,
      scope,
      selected,
      selectedId,
      threadId,
    ],
  );

  const state: MemoryCenterState = {
    open,
    scope,
    entries,
    selected,
    draft,
    draftDirty,
    draftConflict,
    loading,
    saving,
    deleting,
    revision,
    error,
    errorAction,
    command,
    canEdit,
    commandGatewayAvailable: runCommand !== undefined,
    ...(canEdit ? {} : { unavailableReason: "Memory editing is not available in this chat." }),
  };

  return {
    state,
    actions: {
      open: () => setOpenState(true),
      close: () => setOpenState(false),
      setScope: async (next) => {
        if (next === scope || !(await confirmDraftDiscard())) return;
        setScope(next);
        selectedIdRef.current = undefined;
        setSelectedId(undefined);
        draftRef.current = "";
        setDraft("");
        draftDirtyRef.current = false;
        setDraftDirty(false);
        setDraftConflict(false);
        revisionRef.current = null;
        setRevision(null);
        setError(null);
        setErrorAction(null);
        setCommand(null);
      },
      select,
      setDraft: updateDraft,
      reloadDraft,
      keepDraft,
      refresh: async () => {
        await refresh();
      },
      save,
      remove,
      runCommand: executeCommand,
    },
  };
}
