import { AppFailure, type FolderPath, type Rule, type RuleScope } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStableOverlayHost } from "@/overlay";
import { openDestructiveCommandConfirm } from "../../U4/dialogs/confirm-destructive-command";
import type { RuleStoreAdapter } from "../ports";

export interface RulesControllerOptions {
  readonly adapter: RuleStoreAdapter;
  readonly folder: FolderPath;
  readonly scope?: RuleScope;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export interface RulesControllerState {
  readonly open: boolean;
  readonly scope: RuleScope;
  readonly query: string;
  readonly rules: readonly Rule[];
  readonly selected: Rule | undefined;
  readonly draft: string;
  readonly draftDirty: boolean;
  readonly enabled: boolean;
  readonly revision: string | null;
  readonly fileRevision: string | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly error: AppFailure | null;
  readonly errorKind: "load" | "action" | null;
  readonly errorAction: "save" | "delete" | "read" | null;
  readonly conflict: boolean;
  readonly draftKept: boolean;
}

export interface RulesController {
  readonly state: RulesControllerState;
  readonly actions: {
    readonly open: () => void;
    readonly close: () => void;
    readonly setScope: (scope: RuleScope) => Promise<void>;
    readonly setQuery: (query: string) => void;
    readonly select: (id: string | undefined) => Promise<void>;
    readonly setDraft: (draft: string) => void;
    readonly setEnabled: (enabled: boolean) => void;
    readonly refresh: () => Promise<void>;
    readonly save: () => Promise<void>;
    readonly overwrite: () => Promise<void>;
    readonly remove: () => Promise<void>;
    readonly reloadSelected: () => Promise<void>;
    readonly keepDraft: () => void;
  };
}

function failure(error: unknown, fallback: string): AppFailure {
  return error instanceof AppFailure
    ? error
    : new AppFailure({ code: "internal", message: fallback, retryable: true });
}

function validRuleContent(content: string): string | undefined {
  return content.includes("\u0000") ? "Rule content contains an invalid character." : undefined;
}

export function useRulesController({
  adapter,
  folder,
  scope: initialScope = "project",
  open: initiallyOpen = false,
  onOpenChange,
}: RulesControllerOptions): RulesController {
  const overlay = useStableOverlayHost();
  const [open, setOpen] = useState(initiallyOpen);
  const [scope, setScope] = useState<RuleScope>(initialScope);
  const [query, setQuery] = useState("");
  const [rules, setRules] = useState<readonly Rule[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [fileRevision, setFileRevision] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<AppFailure | null>(null);
  const [errorKind, setErrorKind] = useState<"load" | "action" | null>(null);
  const [errorAction, setErrorAction] = useState<"save" | "delete" | "read" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [draftKept, setDraftKept] = useState(false);
  const loadAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const draftRef = useRef("");
  const draftDirtyRef = useRef(false);
  const enabledRef = useRef(false);
  const scopeRevisionRef = useRef<string | null>(null);
  const draftScopeRevisionRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const scopedFolder = scope === "global" ? null : folder;
  const selected = rules.find((rule) => rule.id === selectedId);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle.length === 0
      ? rules
      : rules.filter((rule) => `${rule.name}\n${rule.content}`.toLowerCase().includes(needle));
  }, [query, rules]);

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
        title: "Discard unsaved rule changes?",
        description: "Your unsaved rule changes will be lost.",
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
        setErrorKind(null);
        setErrorAction(null);
      }
      try {
        const result = await adapter.list(
          { folder: scopedFolder, scope },
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return false;
        const changed =
          scopeRevisionRef.current !== null && scopeRevisionRef.current !== result.revision;
        scopeRevisionRef.current = result.revision;
        setRevision(result.revision);
        setRules(result.rules);
        const nextId = result.rules.some((rule) => rule.id === selectedIdRef.current)
          ? selectedIdRef.current
          : undefined;
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
        const nextRule = result.rules.find((rule) => rule.id === nextId);
        setFileRevision(nextRule?.revision ?? null);
        if (draftDirtyRef.current) {
          if (changed) {
            setConflict(true);
            setDraftKept(false);
          }
        } else {
          const nextDraft = nextRule?.content ?? "";
          draftScopeRevisionRef.current = result.revision;
          draftRef.current = nextDraft;
          setDraft(nextDraft);
          setDraftDirty(false);
          setConflict(false);
          setDraftKept(false);
          enabledRef.current = nextRule?.enabled ?? false;
          setEnabled(enabledRef.current);
        }
        return true;
      } catch (cause) {
        if (!abort.signal.aborted && !preserveError) {
          setError(failure(cause, "Rules could not be loaded. Try again."));
          setErrorKind("load");
          setErrorAction(null);
        }
        return false;
      } finally {
        if (loadAbort.current === abort) loadAbort.current = null;
        if (!abort.signal.aborted) setLoading(false);
      }
    },
    [adapter, scope, scopedFolder],
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
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    return adapter.subscribeChanged({ folder: scopedFolder, scope }, () => void refresh(true));
  }, [adapter, open, refresh, scope, scopedFolder]);

  const select = useCallback(
    async (id: string | undefined) => {
      if (id === selectedIdRef.current || !(await confirmDraftDiscard())) return;
      const next = rules.find((rule) => rule.id === id);
      selectedIdRef.current = id;
      setSelectedId(id);
      draftRef.current = next?.content ?? "";
      setDraft(draftRef.current);
      draftDirtyRef.current = false;
      setDraftDirty(false);
      draftScopeRevisionRef.current = scopeRevisionRef.current;
      enabledRef.current = next?.enabled ?? false;
      setEnabled(enabledRef.current);
      setFileRevision(next?.revision ?? null);
      setConflict(false);
      setDraftKept(false);
      setError(null);
      setErrorKind(null);
      setErrorAction(null);
    },
    [confirmDraftDiscard, rules],
  );

  const updateDraft = useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);
      const nextDirty =
        selected !== undefined &&
        (next !== selected.content || enabledRef.current !== selected.enabled);
      if (nextDirty && !draftDirtyRef.current) {
        draftScopeRevisionRef.current = scopeRevisionRef.current;
      } else if (!nextDirty) {
        draftScopeRevisionRef.current = scopeRevisionRef.current;
        setConflict(false);
        setDraftKept(false);
      }
      draftDirtyRef.current = nextDirty;
      setDraftDirty(nextDirty);
    },
    [selected],
  );

  const updateEnabled = useCallback(
    (next: boolean) => {
      enabledRef.current = next;
      setEnabled(next);
      const nextDirty =
        selected !== undefined &&
        (draftRef.current !== selected.content || next !== selected.enabled);
      if (nextDirty && !draftDirtyRef.current) {
        draftScopeRevisionRef.current = scopeRevisionRef.current;
      } else if (!nextDirty) {
        draftScopeRevisionRef.current = scopeRevisionRef.current;
        setConflict(false);
        setDraftKept(false);
      }
      draftDirtyRef.current = nextDirty;
      setDraftDirty(nextDirty);
    },
    [selected],
  );

  const write = useCallback(
    async (expectedRevision: string | null, confirmedOverwrite = false) => {
      if (!selected || saving || (conflict && !confirmedOverwrite)) return;
      const validation = validRuleContent(draftRef.current);
      if (validation) {
        setError(new AppFailure({ code: "invalid_args", message: validation, retryable: false }));
        setErrorKind("action");
        setErrorAction("save");
        return;
      }
      const abort = new AbortController();
      actionAbort.current = abort;
      setSaving(true);
      setError(null);
      setErrorKind(null);
      setErrorAction(null);
      try {
        const result = await adapter.write(
          {
            folder: scopedFolder,
            scope,
            id: selected.id,
            content: draftRef.current,
            enabled: enabledRef.current,
            expectedRevision,
          },
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setRules((current) =>
          current.map((rule) => (rule.id === result.rule.id ? result.rule : rule)),
        );
        scopeRevisionRef.current = result.revision;
        draftScopeRevisionRef.current = result.revision;
        setRevision(result.revision);
        setFileRevision(result.rule.revision);
        draftDirtyRef.current = false;
        setDraftDirty(false);
        setConflict(false);
        setDraftKept(false);
        setError(null);
        setErrorKind(null);
        setErrorAction(null);
      } catch (cause) {
        if (!abort.signal.aborted) {
          const next = failure(cause, "Rule could not be saved. Your draft is still here.");
          if (next.appError.code === "conflict") await refresh(true);
          setError(next);
          setErrorKind("action");
          setErrorAction("save");
          setConflict(next.appError.code === "conflict");
          setDraftKept(false);
        }
      } finally {
        if (actionAbort.current === abort) actionAbort.current = null;
        setSaving(false);
      }
    },
    [adapter, conflict, refresh, saving, scope, scopedFolder, selected],
  );

  const overwrite = useCallback(async () => {
    if (!selected || !conflict) return;
    const confirmed = await openDestructiveCommandConfirm(
      { open: (options) => overlay.open(options) },
      {
        label: "Overwrite rule",
        title: "Overwrite the newer rule?",
        description: "This replaces the newer rule with your draft.",
        confirmLabel: "Overwrite rule",
      },
    );
    if (!confirmed) return;
    const refreshed = await refresh(true);
    if (refreshed && scopeRevisionRef.current !== null) {
      await write(scopeRevisionRef.current, true);
    }
  }, [conflict, overlay, refresh, selected, write]);

  const remove = useCallback(async () => {
    if (!selected || deleting || scopeRevisionRef.current === null) return;
    const confirmed = await openDestructiveCommandConfirm(
      { open: (options) => overlay.open(options) },
      {
        label: "Delete rule",
        title: "Delete this rule?",
        description: `This removes ${selected.name} from the ${scope} rules.`,
        confirmLabel: "Delete rule",
      },
    );
    if (!confirmed) return;
    const abort = new AbortController();
    actionAbort.current = abort;
    setDeleting(true);
    setError(null);
    setErrorKind(null);
    setErrorAction(null);
    try {
      await adapter.delete(
        {
          folder: scopedFolder,
          scope,
          id: selected.id,
          expectedRevision: scopeRevisionRef.current,
        },
        { signal: abort.signal },
      );
      if (!abort.signal.aborted) await refresh();
    } catch (cause) {
      if (!abort.signal.aborted) {
        setError(failure(cause, "Rule could not be deleted. Try again."));
        setErrorKind("action");
        setErrorAction("delete");
      }
    } finally {
      if (actionAbort.current === abort) actionAbort.current = null;
      setDeleting(false);
    }
  }, [adapter, deleting, overlay, refresh, scope, scopedFolder, selected]);

  const reloadSelected = useCallback(async () => {
    if (!selected) return;
    try {
      const latest = await adapter.read({ folder: scopedFolder, scope, id: selected.id });
      setRules((current) => current.map((rule) => (rule.id === latest.id ? latest : rule)));
      setFileRevision(latest.revision);
      draftScopeRevisionRef.current = scopeRevisionRef.current;
      draftRef.current = latest.content;
      setDraft(latest.content);
      draftDirtyRef.current = false;
      setDraftDirty(false);
      enabledRef.current = latest.enabled;
      setEnabled(latest.enabled);
      setConflict(false);
      setDraftKept(false);
      setError(null);
      setErrorKind(null);
      setErrorAction(null);
    } catch (cause) {
      setError(failure(cause, "The newer rule could not be read. Try again."));
      setErrorKind("action");
      setErrorAction("read");
    }
  }, [adapter, scope, scopedFolder, selected]);

  const keepDraft = useCallback(() => {
    setDraftKept(true);
    setError(null);
    setErrorKind(null);
    setErrorAction(null);
  }, []);

  return {
    state: {
      open,
      scope,
      query,
      rules: filtered,
      selected,
      draft,
      draftDirty,
      enabled,
      revision,
      fileRevision,
      loading,
      saving,
      deleting,
      error,
      errorKind,
      errorAction,
      conflict,
      draftKept,
    },
    actions: {
      open: () => setOpenState(true),
      close: () => setOpenState(false),
      setScope: async (next) => {
        if (next === scope || !(await confirmDraftDiscard())) return;
        setScope(next);
        setQuery("");
        setRules([]);
        selectedIdRef.current = undefined;
        setSelectedId(undefined);
        draftRef.current = "";
        setDraft("");
        draftDirtyRef.current = false;
        setDraftDirty(false);
        enabledRef.current = false;
        setEnabled(false);
        setFileRevision(null);
        scopeRevisionRef.current = null;
        draftScopeRevisionRef.current = null;
        setRevision(null);
        setConflict(false);
        setDraftKept(false);
        setError(null);
        setErrorKind(null);
        setErrorAction(null);
      },
      setQuery,
      select,
      setDraft: updateDraft,
      setEnabled: updateEnabled,
      refresh: async () => {
        await refresh();
      },
      save: () => write(draftScopeRevisionRef.current),
      overwrite,
      remove,
      reloadSelected,
      keepDraft,
    },
  };
}
