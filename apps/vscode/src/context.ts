/**
 * What goes with each message from the panel (a `HostContext`): what the person is looking at in VS Code, worked out from
 * a plain account of the editor (`EditorView`), so it is checked without VS Code; `panel.ts` gives the account. The uri
 * names the place the way omp app reads it back (`hostContextPlace` in the contracts): `<path>#L<a>-<b>` for lines,
 * `<path>#cell<n>` for a notebook's cell (counted from 1), and `<path>#cell<n>-L<a>-<b>` for lines in that cell.
 */
import type { HostContext } from "@omp-app/contracts";

/** The most of a selection, or of a cell's text, a message carries (the contracts' `HOST_CONTEXT_SELECTION_MAX`). */
const MOST = 8_000;
/** The contracts' longest title and uri. */
const TITLE_MAX = 300;
const URI_MAX = 2_000;

/** A position as VS Code gives it: a line and a character in it, both counted from 0. */
export interface At {
  readonly line: number;
  readonly character: number;
}

/** What is selected: where it starts and ends, and its text. */
export interface Selected {
  readonly start: At;
  readonly end: At;
  readonly text: string;
}

/** A notebook's cell: its place from 0, top to bottom, its text, and what is selected in it. */
export interface CellView {
  readonly index: number;
  readonly text: string;
  readonly selected?: Selected;
}

/** What the person is looking at in VS Code. */
export type EditorView =
  /** A text file in an editor (in a diff, its changed side). */
  | { readonly kind: "text"; readonly path: string; readonly selected?: Selected }
  /** A notebook, with the cell that has the cursor or else the first selected one. */
  | { readonly kind: "notebook"; readonly path: string; readonly cell?: CellView }
  /** Any other tab: an image, a PDF, a preview; its file when it has one, else its label. */
  | { readonly kind: "tab"; readonly label: string; readonly path?: string };

/** The lines a selection covers, counted from 1; one that ends at the start of a line leaves that line out. */
export function linesOf(selected: Selected): readonly [number, number] {
  const from = selected.start.line + 1;
  const endsBefore = selected.end.character === 0 && selected.end.line > selected.start.line;
  return [from, endsBefore ? selected.end.line : selected.end.line + 1];
}

function uriOf(path: string, cell?: number, lines?: readonly [number, number]): string {
  const range = lines === undefined ? "" : `L${lines[0]}-${lines[1]}`;
  const uri =
    cell !== undefined
      ? `${path}#cell${cell}${range === "" ? "" : `-${range}`}`
      : range === ""
        ? path
        : `${path}#${range}`;
  return uri.slice(0, URI_MAX);
}

const chosen = (selected: Selected | undefined): Selected | undefined =>
  selected === undefined || selected.text === "" ? undefined : selected;

/** The context for what the person is looking at, or none. */
export function contextFor(view: EditorView | null): HostContext | null {
  if (view === null) return null;
  switch (view.kind) {
    case "text": {
      const selected = chosen(view.selected);
      return {
        kind: "file",
        title: view.path.slice(0, TITLE_MAX),
        uri: uriOf(view.path, undefined, selected === undefined ? undefined : linesOf(selected)),
        ...(selected === undefined ? {} : { selection: selected.text.slice(0, MOST) }),
      };
    }
    case "notebook": {
      if (view.cell === undefined) {
        return { kind: "notebook", title: view.path.slice(0, TITLE_MAX), uri: uriOf(view.path) };
      }
      const cell = view.cell.index + 1;
      const selected = chosen(view.cell.selected);
      // With nothing selected, the cell's own text goes, so that "this cell" names something.
      const part =
        selected !== undefined
          ? { selection: selected.text.slice(0, MOST) }
          : view.cell.text.trim() === ""
            ? {}
            : { text: view.cell.text.slice(0, MOST) };
      return {
        kind: "notebook",
        title: `${view.path}, cell ${cell}`.slice(0, TITLE_MAX),
        uri: uriOf(view.path, cell, selected === undefined ? undefined : linesOf(selected)),
        ...part,
      };
    }
    case "tab": {
      if (view.path !== undefined) {
        return { kind: "file", title: view.path.slice(0, TITLE_MAX), uri: uriOf(view.path) };
      }
      const label = view.label.trim();
      return label === "" ? null : { kind: "view", title: label.slice(0, TITLE_MAX) };
    }
  }
}
