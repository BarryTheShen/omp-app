/**
 * What a pairing page said of the frame it runs in, kept with its request and its device: a panel inside another app (a
 * browser extension, VS Code, a site) holds its device's key for that app, so whoever allows the request is told so.
 */

/** Nothing when the page is a page of its own; `framed` when it runs in a frame, `framedBy` when it knew whose. */
export interface Framing {
  readonly framed?: true;
  readonly framedBy?: string;
}

/** The frame a page said it runs in: a known origin means a frame, whatever else the page said. */
export function framingOf(said: {
  readonly framed?: boolean | undefined;
  readonly framedBy?: string | undefined;
}): Framing {
  if (said.framedBy !== undefined) return { framed: true, framedBy: said.framedBy };
  return said.framed === true ? { framed: true } : {};
}
