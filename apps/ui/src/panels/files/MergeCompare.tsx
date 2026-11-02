import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { type ReactNode, useEffect, useRef } from "react";
import { languageFor } from "./CodeEditor";

/**
 * Compare after a conflict (#2782): the disk's version on the left, read-only, and the person's on the right, where
 * they merge; the right side is what Save merged writes. Loaded lazily with the editor.
 */
export interface MergeCompareProps {
  readonly disk: string;
  readonly mine: string;
  readonly path: string;
  /** Hears the right side's text as it is edited. */
  readonly onChange: (merged: string) => void;
}

const THEME = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "var(--panel)", color: "var(--t1)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--t3)", border: "none" },
});

export default function MergeCompare({ disk, mine, path, onChange }: MergeCompareProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  // biome-ignore lint/correctness/useExhaustiveDependencies: made once for the two texts it was opened with
  useEffect(() => {
    if (host.current === null) return;
    const language = languageFor(path);
    const merge = new MergeView({
      parent: host.current,
      a: {
        doc: disk,
        extensions: [
          lineNumbers(),
          language,
          THEME,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: mine,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          language,
          THEME,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString());
          }),
        ],
      },
    });
    return () => merge.destroy();
  }, []);

  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className="grid grid-cols-2 text-xs text-t3">
        <span>On disk now</span>
        <span>Yours: merge here</span>
      </div>
      <div
        ref={host}
        data-testid="merge-compare"
        className="max-h-[60vh] min-h-0 overflow-auto rounded-md border border-l2"
      />
    </div>
  );
}
