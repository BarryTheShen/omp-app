import type { AppClient } from "@omp-app/client";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { setGroupTools } from "../chat/groupTools";
import { setSetupOpen } from "../setup/open";
import { keptRecord, type Setters, undoSetup } from "../setup/record";
import { setStyle } from "../theme/style";
import { setThemeMode, type ThemeMode } from "../theme/theme";
import { setCloseAfter } from "../workspace/closeIdle";
import { useConfig } from "./useConfig";

/** Settings → App → Set up: runs the setup again, and Undo setup puts back what it last changed. */
export function SetupSection({ client }: { readonly client: AppClient }): ReactNode {
  const config = useConfig(client, { layer: "global", folder: null });
  const [record, setRecord] = useState(keptRecord);
  const [problem, setProblem] = useState<string | null>(null);
  const setters: Setters = {
    browser: (setting, value) => {
      if (setting === "themeMode") setThemeMode(value as ThemeMode);
      else if (setting === "style") setStyle(String(value));
      else if (setting === "groupTools") setGroupTools(value === true);
      else setCloseAfter(value === null ? null : Number(value));
    },
    omp: (key, value) => config.write(key, value === "unset" ? "unset" : { secret: false, value }),
  };
  return (
    <>
      <h3 className="mt-6 text-xs font-medium text-t3">Set up</h3>
      <div className="flex items-center gap-4 border-b border-l1 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">Set up omp-app</p>
          <p className="mt-0.5 text-xs text-t3">
            A few questions about how you use omp, then the settings that fit, shown before anything
            changes.
            {record !== null &&
              ` Last run ${new Date(record.at).toLocaleString()}: ${record.changes.length} ${record.changes.length === 1 ? "setting" : "settings"} changed.`}
          </p>
          {problem !== null && (
            <p role="alert" className="mt-1 text-xs text-bad-ink">
              {problem}
            </p>
          )}
        </div>
        {record !== null && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!config.loaded}
            onClick={() => {
              setProblem(null);
              undoSetup(record, setters).then(
                () => setRecord(null),
                (failure: unknown) =>
                  setProblem(
                    `Could not undo every change: ${failure instanceof Error ? failure.message : String(failure)}`,
                  ),
              );
            }}
          >
            Undo setup
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => setSetupOpen(true)}>
          Set up
        </Button>
      </div>
    </>
  );
}
