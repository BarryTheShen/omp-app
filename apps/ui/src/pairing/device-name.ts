import type { DeviceKind } from "@omp-app/contracts";
import { desktopBridge } from "../desktop/bridge";

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

/**
 * What the guess reads: the browser's user agent, whether the page runs as a Home Screen app, the desktop window, and
 * the host when the page is a panel in another app's frame.
 */
export interface DeviceSigns {
  readonly userAgent: string;
  /** iOS's `navigator.standalone`, or `display-mode: standalone`. */
  readonly standalone: boolean;
  /** The app's desktop window (its bridge is present). */
  readonly desktopWindow: boolean;
  /** The name of the app that frames this page as a panel (the embed host's `hello`: "zen", "vscode"); none when it is no panel. */
  readonly host?: string | null;
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

/** What the person may type for a name (`DeviceName`): a longer one is refused by the app. */
const NAME_MAX = 60;

/** `what on place`, the place cut short when the whole would be longer than a name may be. */
function named(what: string, place: string): string {
  return `${what} on ${place.slice(0, NAME_MAX - what.length - " on ".length)}`;
}

/** A panel, by its host: the Firefox and Zen sidebar and VS Code's panel are known by their own names. */
function panelOf(host: string): string {
  if (host === "zen") return "Zen sidebar";
  if (host === "vscode") return "VS Code";
  return `${host} panel`;
}

/**
 * The name and kind the pairing screen suggests; the person may change the name. The name says what the page is and
 * which computer it is on ("Zen sidebar on my-laptop", "Home Screen app on my-phone"): the computer's name as the app
 * knows it (`machine`, from the server), else the system's ("Linux", "iPhone"). The lists and the prompt show the kind
 * beside the name; a browser's name says which browser, so two on one computer differ.
 */
export function guessDevice(signs: DeviceSigns, machine: string | null): DeviceGuess {
  const place = machine ?? systemOf(signs.userAgent);
  if (signs.desktopWindow) return { name: named("Desktop app", place), kind: "desktop-window" };
  if (signs.standalone) return { name: named("Home Screen app", place), kind: "home-screen-app" };
  if (signs.host) return { name: named(panelOf(signs.host), place), kind: "browser" };
  return { name: named(browserOf(signs.userAgent), place), kind: "browser" };
}

/** This page's guess: its browser, whether it runs from the Home Screen or as a panel, and whether it is the desktop window. */
export function guessThisDevice(host: string | null, machine: string | null): DeviceGuess {
  return guessDevice(
    {
      userAgent: navigator.userAgent,
      standalone:
        ("standalone" in navigator && navigator.standalone === true) ||
        matchMedia("(display-mode: standalone)").matches,
      desktopWindow: desktopBridge() !== null,
      host,
    },
    machine,
  );
}
