import { FramedBy } from "@omp-app/contracts";
import { embed } from "../lite/embed";

/**
 * What a pairing page tells the app of the frame it runs in: nothing when it is a page of its own; `framed` whenever it
 * runs in a frame (the browser says so, whatever the app around it does), and `framedBy` when it knows that app's origin.
 * Whoever allows the request is told which app the panel is inside, and that the panel will hold the device's key.
 */
export interface PageFrame {
  readonly framed?: true;
  readonly framedBy?: string;
}

/** The first of these that is an origin the app can name (`FramedBy`), else null. */
export function framedByOf(...origins: readonly (string | null | undefined)[]): string | null {
  for (const origin of origins) {
    if (typeof origin === "string" && FramedBy.safeParse(origin).success) return origin;
  }
  return null;
}

/**
 * This page's frame, for the pairing routes. The origin is the one the host's first `hello` came from (the browser's
 * word, which the host cannot change), else the browser's list of ancestors where it keeps one (Firefox does not).
 * A framed page that knows neither waits for the host's `hello` (3 s at most) before it says it is framed without an
 * origin: a host that never says who it is is still shown as a panel.
 */
export async function frameOfThisPage(): Promise<PageFrame> {
  if (window.parent === window) return {};
  const known = (): string | null =>
    framedByOf(embed?.getSnapshot().origin, window.location.ancestorOrigins?.[0]);
  if (known() === null) await embed?.helloSettled();
  const framedBy = known();
  return framedBy === null ? { framed: true } : { framed: true, framedBy };
}

/** What a request or a device says of its frame (`PairingRequest`, `PairedDevice`). */
export interface Framed {
  readonly framed?: boolean | undefined;
  readonly framedBy?: string | undefined;
  /** A request only: the name of a device that paired from the same app before, else null. */
  readonly framedBefore?: string | null | undefined;
}

/** The app an origin names, in words the person knows it by. */
function appOf(origin: string): string {
  const at = origin.indexOf("://");
  const scheme = origin.slice(0, at);
  const rest = origin.slice(at + 3);
  const start = rest.length > 8 ? `${rest.slice(0, 8)}…` : rest;
  switch (scheme) {
    case "moz-extension":
      return `a Firefox or Zen extension (moz-extension://${start})`;
    case "chrome-extension":
      return `a Chrome or Edge extension (chrome-extension://${start})`;
    case "vscode-webview":
    case "vscode-file":
      return "VS Code";
    default:
      return rest;
  }
}

/** Which app the panel is inside ("a Firefox or Zen extension (moz-extension://1a2b3c4d…)"); null when it is no panel. */
export function panelInside(from: Framed): string | null {
  if (from.framedBy !== undefined) return appOf(from.framedBy);
  return from.framed === true ? "another app that did not say which" : null;
}

/**
 * What the person allowing a request is told when it comes from a panel: the app it is inside, that the panel will hold
 * the device's key, and whether that app paired before. Null when the request is from a page of its own.
 */
export function panelWarning(request: Framed): string | null {
  const inside = panelInside(request);
  if (inside === null) return null;
  const held = `In a panel inside ${inside}. It will hold this device's key.`;
  if (request.framedBy === undefined || request.framedBefore === undefined) return held;
  return request.framedBefore === null
    ? `${held} This app has not paired before.`
    : `${held} The same app paired before as ${request.framedBefore}.`;
}
