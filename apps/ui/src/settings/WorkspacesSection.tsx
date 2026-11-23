import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CLOSE_AFTER_CHOICES,
  closeAfterWords,
  setCloseAfter,
  useCloseAfter,
} from "../workspace/closeIdle";

const LABEL = "Close workspaces not used for";
const choices = CLOSE_AFTER_CHOICES.map((hours) => ({
  value: hours === null ? "never" : String(hours),
  label: closeAfterWords(hours),
}));

/** Settings → App → Workspaces: how long a workspace may stay out of front before it closes by itself. */
export function WorkspacesSection(): ReactNode {
  const hours = useCloseAfter();
  return (
    <>
      <h3 className="mt-6 text-xs font-medium text-t3">Workspaces</h3>
      <div className="flex items-center gap-4 border-b border-l1 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">{LABEL}</p>
          <p className="mt-0.5 text-xs text-t3">
            A workspace you have not had in front for this long closes by itself, unless it is
            pinned, or its chat works or waits for you. Its chat stays in the list, and Reopen
            (Ctrl+Shift+T) brings the workspace back. Kept in this browser.
          </p>
        </div>
        <Select
          items={choices}
          value={hours === null ? "never" : String(hours)}
          onValueChange={(next) => {
            if (typeof next === "string") setCloseAfter(next === "never" ? null : Number(next));
          }}
        >
          <SelectTrigger
            aria-label={LABEL}
            size="sm"
            className="min-w-36 justify-between dark:bg-transparent"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
