import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * The Files panel's text editor (#2782): CodeMirror 6, loaded only when a text viewer opens (this module is imported
 * lazily). Read-only until the person chooses Edit; line numbers; a wrap toggle; Ctrl/Cmd+S saves.
 */
export interface CodeEditorProps {
  readonly value: string;
  /** The file's path, for its language. */
  readonly path: string;
  readonly readOnly: boolean;
  readonly wrap: boolean;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
}

/** The language for a file's extension; none for plain text. */
export function languageFor(path: string): Extension {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
    case "jsonc":
    case "ipynb":
      return json();
    case "py":
    case "pyi":
      return python();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    default:
      return [];
  }
}

/** On the app's own colours, so it follows the theme. */
const THEME = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--panel)", color: "var(--t1)" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--t3)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--l1)" },
  ".cm-cursor": { borderLeftColor: "var(--t1)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--accent) 28%, transparent)",
  },
});

/** Code in the theme's own code colours (#2801), as code in a chat (`--syn-*` in `styles/themes.css`). */
const CODE_COLOURS = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.tagName, t.processingInstruction], color: "var(--syn-keyword)" },
  { tag: [t.string, t.regexp, t.url, t.escape], color: "var(--syn-string)" },
  {
    tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName)],
    color: "var(--syn-number)",
  },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.function(t.definition(t.variableName)),
    ],
    color: "var(--syn-function)",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.special(t.variableName), t.self], color: "var(--syn-variable)" },
  { tag: t.operator, color: "var(--syn-operator)" },
  // A member access's `.` stays in the text's colour.
  { tag: t.derefOperator, color: "inherit" },
  { tag: t.heading, color: "var(--syn-function)", fontWeight: "600" },
  { tag: t.monospace, color: "var(--syn-string)" },
  { tag: t.link, color: "var(--accent-ink)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.inserted, color: "var(--ok-ink)" },
  { tag: [t.deleted, t.invalid], color: "var(--bad-ink)" },
]);

export default function CodeEditor({
  value,
  path,
  readOnly,
  wrap,
  onChange,
  onSave,
}: CodeEditorProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is made once per file; later changes below
  useEffect(() => {
    if (host.current === null) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(CODE_COLOURS),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                handlers.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          languageFor(path),
          THEME,
          editable.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [path]);

  // A value from outside (a reload from disk, a conflict settled) replaces the text; typing comes back the same.
  useEffect(() => {
    const editor = view.current;
    if (editor === null || editor.state.doc.toString() === value) return;
    const scroll = editor.scrollDOM.scrollTop;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    editor.scrollDOM.scrollTop = scroll;
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  return <div ref={host} data-testid="code-editor" className="h-full min-h-0 overflow-hidden" />;
}
