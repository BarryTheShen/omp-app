import { useShortcutPreferenceError } from "./context";

/** The notice for a saved shortcut preference the app cannot read: the defaults are in use, and the sheet resets them. */
const SHORTCUT_PREFERENCE_NOTICE =
  "Could not load saved shortcuts, so the default shortcuts are in use. Open Keyboard shortcuts and choose Reset all.";

/**
 * The header's message while the saved shortcuts cannot be read. It is a single paragraph: each header places it in the
 * block that floats its messages over the chat, above any command message. It goes when the shortcuts are reset or
 * rebound, which clears the saved preference.
 */
export function ShortcutPreferenceNotice() {
  const preferenceError = useShortcutPreferenceError();
  if (preferenceError === undefined) return null;
  return (
    <p
      className="border-border bg-popover text-danger shadow-overlay rounded-md border px-3 py-2 text-xs"
      role="alert"
    >
      {SHORTCUT_PREFERENCE_NOTICE}
    </p>
  );
}
