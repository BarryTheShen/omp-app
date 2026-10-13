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
    <fieldset
      data-slot="u2-mode-indicator"
      className="flex min-w-0 flex-wrap items-center gap-(--space-2xs) border-0 p-0"
    >
      <legend className="sr-only">Input mode</legend>
      <Button
        type="button"
        variant={mode === "prompt" ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={mode === "prompt"}
        onClick={() => changeMode("prompt")}
      >
        Prompt
      </Button>
      <Button
        type="button"
        variant={mode === "bash" ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={mode === "bash"}
        onClick={() => changeMode("bash")}
      >
        Bash
      </Button>
      <span className="inline-flex" title={python.available ? undefined : python.reason}>
        <Button
          type="button"
          variant={mode === "python" ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={mode === "python"}
          disabled={!python.available}
          title={python.available ? "Python mode" : undefined}
          onClick={() => changeMode("python")}
        >
          Python
        </Button>
      </span>
    </fieldset>
  );
};
