import type { DeviceKind } from "@omp-app/contracts";

/** A device kind in words, as the device lists and the request prompt show it beside a device's name. */
export const DEVICE_KIND_WORDS: Record<DeviceKind, string> = {
  "home-screen-app": "Home Screen app",
  "desktop-window": "desktop window",
  browser: "browser",
};

/** What the pairing screen guesses this device is: the name it suggests, and its kind. */
export interface DeviceGuess {
  readonly name: string;
  readonly kind: DeviceKind;
}

/** What the guess reads: the browser's user agent, whether the page runs as a Home Screen app, and the desktop window. */
export interface DeviceSigns {
  readonly userAgent: string;
  /** iOS's `navigator.standalone`, or `display-mode: standalone`. */
  readonly standalone: boolean;
  /** The app's desktop window (its bridge is present). */
  readonly desktopWindow: boolean;
}

function systemOf(agent: string): string {
  if (/iPad/.test(agent)) return "iPad";
  if (/iPhone|iPod/.test(agent)) return "iPhone";
  if (/Android/.test(agent)) return "Android";
  if (/Macintosh|Mac OS X/.test(agent)) return "Mac";
  if (/Windows/.test(agent)) return "Windows";
  if (/CrOS/.test(agent)) return "Chromebook";
  if (/Linux/.test(agent)) return "Linux";
  return "This computer";
}

function browserOf(agent: string): string {
  if (/Edg\//.test(agent)) return "Edge";
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(agent)) return "Chrome";
  if (/Safari\//.test(agent)) return "Safari";
  return "browser";
}

/**
 * The name and kind the pairing screen suggests; the person may change the name. The name says which device it is and
 * leaves the kind out, which the lists and the prompt show beside it ("iPhone (Home Screen app)"); a browser's name
 * says which browser, so two on one computer differ.
 */
export function guessDevice(signs: DeviceSigns): DeviceGuess {
  const system = systemOf(signs.userAgent);
  if (signs.desktopWindow) return { name: system, kind: "desktop-window" };
  if (signs.standalone) return { name: system, kind: "home-screen-app" };
  return { name: `${system} · ${browserOf(signs.userAgent)}`, kind: "browser" };
}
