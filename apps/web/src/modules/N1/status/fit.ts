/** A segment's id and the room its whole text takes, in pixels. */
export interface SegmentWidth {
  readonly id: string;
  readonly width: number;
}

/**
 * The segments that fit in `room` pixels, taken in the order given (most important first). A segment is kept whole
 * when it fits beside the ones already kept, with `gap` pixels between them. One that does not fit is left out, and the
 * next one is tried, so a segment is never cut to make room.
 */
export function fitSegments(
  segments: readonly SegmentWidth[],
  room: number,
  gap: number,
): ReadonlySet<string> {
  const kept = new Set<string>();
  let used = 0;
  for (const segment of segments) {
    const needed = kept.size === 0 ? segment.width : used + gap + segment.width;
    if (needed > room) continue;
    kept.add(segment.id);
    used = needed;
  }
  return kept;
}
