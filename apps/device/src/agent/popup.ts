/**
 * An agent's request shown by this computer's agent itself while no desktop window watches (the app is closed): the
 * same lasting notification the window shows (`apps/desktop/src-tauri/src/access.rs`), with the desktop's question
 * sound, whose click starts the desktop app, which opens on Agent access while a request waits. Nothing here asks a
 * password: Allow in the panel does. Uses `notify-send` (libnotify 0.8: `--print-id`, `--action`, which waits) and
 * `gdbus` to take a notification away, both in the person's desktop session.
 */
import { spawn } from "node:child_process";

export interface Popup {
  /** Takes the notification away (answered elsewhere, or a window now shows the requests). */
  close(): void;
}

export type ShowPopup = (summary: string, body: string, clicked: () => void) => Popup;

/** Notification bodies may be read as markup (the freedesktop `body-markup`): shown as text, never as markup. */
const asText = (text: string): string =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const showPopup: ShowPopup = (summary, body, clicked) => {
  const child = spawn(
    "notify-send",
    [
      "--app-name=omp app",
      "--urgency=critical",
      "--hint=string:sound-name:dialog-question",
      "--hint=string:desktop-entry:omp-app-desktop",
      "--hint=boolean:resident:true",
      "--print-id",
      "--action=default=Open Agent access",
      asText(summary),
      asText(body),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  child.on("error", () => undefined);
  let id: string | null = null;
  let closed = false;
  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    rest += chunk.toString();
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines.map((each) => each.trim())) {
      if (id === null && /^\d+$/.test(line)) id = line;
      else if (line === "default" && !closed) clicked();
    }
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      if (id !== null) {
        const taken = spawn(
          "gdbus",
          [
            "call",
            "--session",
            "--dest=org.freedesktop.Notifications",
            "--object-path=/org/freedesktop/Notifications",
            "--method=org.freedesktop.Notifications.CloseNotification",
            id,
          ],
          { stdio: "ignore" },
        );
        taken.on("error", () => undefined);
      }
      child.kill();
    },
  };
};

/** Starts the desktop app (its launcher, as the applications menu does). */
export function openDesktopApp(): void {
  const started = spawn("gtk-launch", ["omp-app-desktop"], { stdio: "ignore", detached: true });
  started.on("error", () => undefined);
  started.unref();
}
