import { chordLabel, isApplePlatform, useShortcutBindings } from "@/shortcuts";
import { useTranscriptDisplayPolicy } from "./policy";

/** The shortcut that shows tool activity again (Mod+Shift+O by default). */
const TOOLS_TOGGLE_ID = "U1.appToolsToggleVisibility";

/**
 * A muted line in the thread footer while tool activity is hidden. It names the chord the person has bound for showing
 * it again, in the names their keyboard uses (the shortcut sheet's names). The live region stays mounted, so the line
 * is read out politely when it appears; while tool activity is shown the region is empty.
 */
export function ToolsHiddenNotice() {
  const { tools } = useTranscriptDisplayPolicy();
  const binding = useShortcutBindings().find((entry) => entry.id === TOOLS_TOGGLE_ID);
  const text =
    tools === "hidden" && binding !== undefined
      ? `Tool activity is hidden. Press ${chordLabel(binding.chord, { mac: isApplePlatform() })} to show it.`
      : "";
  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="text-muted-foreground text-xs"
      data-u1-tools-hidden-notice=""
    >
      {text}
    </p>
  );
}
