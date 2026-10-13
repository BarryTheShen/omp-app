/**
 * A notice the chat draws. `afterRow` is the id of the row it follows: null when it came before the first row (the
 * transcript was empty), undefined when it names no row (drawn after the last row, as notices always were).
 */
export interface ThreadNotice {
  readonly key: string;
  readonly afterRow: string | null | undefined;
}

/** Where each notice is drawn: before the first row, after the row with this id, or after the last row. */
export interface NoticePlacement {
  readonly top: readonly string[];
  readonly after: ReadonlyMap<string, readonly string[]>;
  readonly end: readonly string[];
}

/**
 * Places each notice after the row it follows, in the order the notices came. A row the chat does not draw (a tool
 * result joined into the answer before it, a hidden message) falls back to the nearest drawn row before it. A notice
 * with no drawn row before it goes to the top. A notice that names no row, or a row the transcript does not hold, goes
 * to the end.
 *
 * `rowOrder` lists the row ids of the transcript, oldest first. `drawnRows` holds the ids of the rows the chat draws.
 */
export function placeNotices(
  notices: readonly ThreadNotice[],
  rowOrder: readonly string[],
  drawnRows: ReadonlySet<string>,
): NoticePlacement {
  const position = new Map<string, number>();
  for (const [index, row] of rowOrder.entries()) {
    if (!position.has(row)) position.set(row, index);
  }
  const top: string[] = [];
  const end: string[] = [];
  const after = new Map<string, string[]>();
  for (const notice of notices) {
    if (notice.afterRow === undefined) {
      end.push(notice.key);
      continue;
    }
    if (notice.afterRow === null) {
      top.push(notice.key);
      continue;
    }
    const index = position.get(notice.afterRow);
    if (index === undefined) {
      end.push(notice.key);
      continue;
    }
    const drawn = nearestDrawnRow(rowOrder, drawnRows, index);
    if (drawn === undefined) {
      top.push(notice.key);
      continue;
    }
    after.set(drawn, [...(after.get(drawn) ?? []), notice.key]);
  }
  return { top, after, end };
}

/** The drawn row at `index`, or the nearest one before it; undefined when no row up to there is drawn. */
function nearestDrawnRow(
  rowOrder: readonly string[],
  drawnRows: ReadonlySet<string>,
  index: number,
): string | undefined {
  for (let at = index; at >= 0; at -= 1) {
    const row = rowOrder[at];
    if (row !== undefined && drawnRows.has(row)) return row;
  }
  return undefined;
}
