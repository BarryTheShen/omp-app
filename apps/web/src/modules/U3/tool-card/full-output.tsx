import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/** Loads the full text of a tool output the thread shows shortened. Set by the thread shell. */
export type LoadFullOutput = (toolCallId: string) => Promise<void>;

const FullOutputContext = createContext<LoadFullOutput | undefined>(undefined);

export const FullOutputProvider = FullOutputContext.Provider;

export interface OutputCut {
  /** The bytes of the output the card shows: its head and its tail. */
  readonly shownBytes: number;
  /** The bytes of the whole output. */
  readonly totalBytes: number;
}

/**
 * The cut a reader made to a tool result, if any. The result carries `outputCut` when the thread
 * shortened its output; anything else (a live result, a result that was never cut) has none.
 */
export function outputCutOf(result: unknown): OutputCut | undefined {
  if (typeof result !== "object" || result === null || !("outputCut" in result)) return undefined;
  const cut = result.outputCut;
  if (typeof cut !== "object" || cut === null) return undefined;
  if (!("shownBytes" in cut) || !("totalBytes" in cut)) return undefined;
  const { shownBytes, totalBytes } = cut;
  if (typeof shownBytes !== "number" || typeof totalBytes !== "number") return undefined;
  return { shownBytes, totalBytes };
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Says how much of a tool output the thread shows, and offers the full text when the card sits in a
 * thread that can load it. The note states the facts whether or not the action is there. A caller
 * that knows more (a bash card says how many of its lines it shows) passes `lead` in place of the
 * default sentence.
 *
 * While the output loads, the button says so with aria-disabled rather than disabled: a disabled
 * button drops focus, and a keyboard user would land at the top of the page. When the output is
 * there, `onLoaded` runs, and the card moves focus to its own "Show all" control (useFullOutputFocus).
 */
export function OutputCutNote({
  cut,
  toolCallId,
  lead,
  onLoaded,
}: {
  readonly cut: OutputCut;
  readonly toolCallId: string;
  readonly lead?: string;
  readonly onLoaded?: () => void;
}): ReactNode {
  const loadFull = useContext(FullOutputContext);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // A press while the output loads does nothing: the render that marks the button busy may not have happened yet.
  const inFlight = useRef(false);
  const load = async (): Promise<void> => {
    if (loadFull === undefined || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(undefined);
    try {
      await loadFull(toolCallId);
      onLoaded?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Loading the full output failed");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
      data-slot="u3-tool-card-cut"
    >
      <span>
        {lead ?? (
          <>
            Showing the start and end of {formatBytes(cut.totalBytes)};{" "}
            {formatBytes(cut.shownBytes)} is shown.
          </>
        )}
      </span>
      {loadFull !== undefined && (
        <button
          aria-disabled={loading}
          className="border-border bg-background hover:bg-muted rounded-md border px-2 py-1 font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-wait aria-disabled:opacity-60"
          type="button"
          onClick={() => void load()}
        >
          {loading ? "Loading full output…" : "Load full output"}
        </button>
      )}
      {error !== undefined && (
        <span className="text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The focus and the notice of a loaded full output, for the card that holds the note. The note goes
 * once the output is loaded, so focus moves to the card's own "Show all" control: the first element
 * matching `control` inside `scope`, once the note is gone. `loaded` says the output arrived, for the
 * card's status line.
 */
export function useFullOutputFocus(
  cut: OutputCut | undefined,
  scope: RefObject<HTMLElement | null>,
  control: string,
): { readonly loaded: boolean; readonly onLoaded: () => void } {
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const cutGone = cut === undefined;
  useEffect(() => {
    if (!pending || !cutGone) return;
    setPending(false);
    setLoaded(true);
    scope.current?.querySelector<HTMLElement>(control)?.focus();
  }, [control, cutGone, pending, scope]);
  return { loaded, onLoaded: () => setPending(true) };
}
