import type { AppClient } from "@omp-app/client";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { debugLogFailureText, saveDebugLog, savedDebugLogText } from "../debugLog";

type Saving =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string };

/**
 * Settings → App → Debug log: saves the app's debug log as a file to attach to an issue. The palette has the same
 * command; this is where a phone, which has no palette, finds it.
 */
export function DebugLog({ client }: { readonly client: AppClient }): ReactNode {
  const [saving, setSaving] = useState<Saving>({ kind: "idle" });
  const save = (): void => {
    setSaving({ kind: "saving" });
    saveDebugLog(client).then(
      (fileName) => setSaving({ kind: "saved", text: savedDebugLogText(fileName) }),
      (failure: unknown) => setSaving({ kind: "failed", text: debugLogFailureText(failure) }),
    );
  };
  return (
    <section aria-label="Debug log" data-tour="debug-log">
      <h3 className="mt-6 text-xs font-medium text-t3">Debug log</h3>
      <p className="mt-2 text-sm text-t2">
        What the app did, as one file to attach to an issue when something goes wrong: its versions,
        the last lines of its log and the page's errors. It never holds your prompts, file contents
        or keys; file paths and error messages can be in it, so look it over before you share it.
      </p>
      <div className="mt-3 flex flex-col items-start gap-2">
        <Button size="sm" variant="outline" disabled={saving.kind === "saving"} onClick={save}>
          {saving.kind === "saving" ? "Saving…" : "Save debug log"}
        </Button>
        {saving.kind === "saved" && (
          <p role="status" className="text-sm text-t2">
            {saving.text}
          </p>
        )}
        {saving.kind === "failed" && (
          <p role="alert" className="text-sm text-bad-ink">
            {saving.text}
          </p>
        )}
      </div>
    </section>
  );
}
