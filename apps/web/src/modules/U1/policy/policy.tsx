import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export interface ThinkingVisibilityStore {
  get(key: string): boolean | undefined;
  set(key: string, value: boolean): void;
}

export class MemoryThinkingVisibilityStore implements ThinkingVisibilityStore {
  private readonly values = new Map<string, boolean>();

  public get(key: string): boolean | undefined {
    return this.values.get(key);
  }

  public set(key: string, value: boolean): void {
    this.values.set(key, value);
  }
}

export interface TranscriptDisplayPolicy {
  readonly threadId: string;
  readonly thinking: "visible" | "hidden";
  readonly tools: "visible" | "hidden";
  readonly expandTools: boolean;
  readonly storageError?: string;
  readonly setThinking: (thinking: "visible" | "hidden") => void;
  readonly toggleThinking: () => void;
  /** Shows or hides tool activity (omp's app.tools.toggleVisibility). Held for this chat's view only. */
  readonly toggleTools: () => void;
  /** Expands or collapses every tool output (omp's app.tools.expand). Held for this chat's view only. */
  readonly toggleExpandTools: () => void;
}

export interface TranscriptDisplayPolicyProviderProps {
  readonly threadId: string;
  readonly storage?: ThinkingVisibilityStore;
  readonly children: ReactNode;
}

export function shouldRenderReasoning({
  active,
  policy,
}: {
  readonly active: boolean;
  readonly policy: TranscriptDisplayPolicy;
}): boolean {
  return policy.thinking === "visible" || active;
}

const STORAGE_PREFIX = "omp.u1.thinking.visibility.";
const DEFAULT_POLICY: TranscriptDisplayPolicy = {
  threadId: "unbound",
  thinking: "visible",
  tools: "visible",
  expandTools: false,
  setThinking: () => undefined,
  toggleThinking: () => undefined,
  toggleTools: () => undefined,
  toggleExpandTools: () => undefined,
};
const TranscriptDisplayPolicyContext = createContext<TranscriptDisplayPolicy>(DEFAULT_POLICY);

function storageKey(threadId: string): string {
  return `${STORAGE_PREFIX}${threadId}`;
}

function browserStorage(): ThinkingVisibilityStore | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    if (window.localStorage === undefined) return undefined;
    return {
      get(key) {
        const value = window.localStorage.getItem(key);
        if (value === null) return undefined;
        return value === "true";
      },
      set(key, value) {
        window.localStorage.setItem(key, String(value));
      },
    };
  } catch {
    return undefined;
  }
}

function readVisibility(
  storage: ThinkingVisibilityStore | undefined,
  threadId: string,
): { readonly value: "visible" | "hidden"; readonly error?: string } {
  if (storage === undefined) return { value: "visible" };
  try {
    return { value: storage.get(storageKey(threadId)) === false ? "hidden" : "visible" };
  } catch {
    return { value: "visible", error: "Thinking visibility could not be loaded." };
  }
}

export function TranscriptDisplayPolicyProvider({
  threadId,
  storage,
  children,
}: TranscriptDisplayPolicyProviderProps) {
  const resolvedStorage = useMemo(() => storage ?? browserStorage(), [storage]);
  const initial = useMemo(
    () => readVisibility(resolvedStorage, threadId),
    [resolvedStorage, threadId],
  );
  const [activeThreadId, setActiveThreadId] = useState(threadId);
  const [thinking, setThinking] = useState<"visible" | "hidden">(initial.value);
  const [storageError, setStorageError] = useState<string | undefined>(initial.error);
  const [tools, setTools] = useState<"visible" | "hidden">("visible");
  const [expandTools, setExpandTools] = useState(false);

  useEffect(() => {
    if (activeThreadId === threadId) return;
    const next = readVisibility(resolvedStorage, threadId);
    setActiveThreadId(threadId);
    setThinking(next.value);
    setStorageError(next.error);
    setTools("visible");
    setExpandTools(false);
  }, [activeThreadId, resolvedStorage, threadId]);

  useEffect(() => {
    if (activeThreadId !== threadId || resolvedStorage === undefined) return;
    try {
      resolvedStorage.set(storageKey(threadId), thinking === "visible");
      setStorageError(undefined);
    } catch {
      setStorageError("Thinking visibility could not be saved.");
    }
  }, [activeThreadId, resolvedStorage, thinking, threadId]);

  const setThinkingValue = useCallback((value: "visible" | "hidden") => setThinking(value), []);
  const toggleThinking = useCallback(
    () => setThinking((value) => (value === "visible" ? "hidden" : "visible")),
    [],
  );
  const toggleTools = useCallback(
    () => setTools((value) => (value === "visible" ? "hidden" : "visible")),
    [],
  );
  const toggleExpandTools = useCallback(() => setExpandTools((value) => !value), []);
  const value = useMemo<TranscriptDisplayPolicy>(
    () => ({
      threadId,
      thinking,
      tools,
      expandTools,
      storageError,
      setThinking: setThinkingValue,
      toggleThinking,
      toggleTools,
      toggleExpandTools,
    }),
    [
      setThinkingValue,
      storageError,
      thinking,
      threadId,
      tools,
      expandTools,
      toggleThinking,
      toggleTools,
      toggleExpandTools,
    ],
  );

  return (
    <TranscriptDisplayPolicyContext.Provider value={value}>
      {children}
    </TranscriptDisplayPolicyContext.Provider>
  );
}

export function useTranscriptDisplayPolicy(): TranscriptDisplayPolicy {
  return useContext(TranscriptDisplayPolicyContext);
}
