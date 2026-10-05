import { useAui, useAuiState } from "@assistant-ui/react";
import type { CapabilityMap } from "@omp-app/contracts";
import type { FC } from "react";
import { Button } from "../../../components/ui/button";
import { modeForText, pythonModeAvailability, textForMode } from "./modes";

export interface ModeIndicatorProps {
  readonly capabilities: CapabilityMap;
}

/** Compact composer mode control whose highlighted mode is always derived from composer text. */
export const ModeIndicator: FC<ModeIndicatorProps> = ({ capabilities }) => {
  const aui = useAui();
  const text = useAuiState((state) => state.composer.text);
  const mode = modeForText(text);
  const python = pythonModeAvailability(capabilities);
  const changeMode = (next: "prompt" | "bash" | "python") => {
    aui.composer.setText(textForMode(text, next));
  };
  return (
    <div data-slot="u2-mode-indicator" className="flex items-center gap-(--space-xs)">
      <Button
        type="button"
        variant={mode === "prompt" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={mode === "prompt"}
        onClick={() => changeMode("prompt")}
      >
        Prompt
      </Button>
      <Button
        type="button"
        variant={mode === "bash" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={mode === "bash"}
        onClick={() => changeMode("bash")}
      >
        Bash
      </Button>
      <Button
        type="button"
        variant={mode === "python" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={mode === "python"}
        disabled={!python.available}
        title={python.available ? "Python mode" : python.reason}
        onClick={() => changeMode("python")}
      >
        Python
      </Button>
      {!python.available && <span className="text-muted-foreground text-xs">{python.reason}</span>}
    </div>
  );
};
