import type { AppClient } from "@omp-app/client";
import { SharesPort, type SharesSettings } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * Whether a service a chat starts (a dev server on a port someone picked) is shared with the paired devices by itself.
 * On unless turned off; services shared already stay shared, and any service can still be shared by hand in the Ports
 * panel. Not shown by a server older than the setting.
 */
export function SharingSection({ client }: { readonly client: AppClient }): ReactNode {
  const [settings, setSettings] = useState<SharesSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .port(SharesPort)
      .settings({})
      .then(
        (read) => alive && setSettings(read),
        // A server older than the setting has no such method: the section is not shown.
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [client]);

  if (settings === null) return null;

  const save = (autoShare: boolean): void => {
    setSaving(true);
    setProblem(null);
    client
      .port(SharesPort)
      .setSettings({ autoShare })
      .then(setSettings, (failure: unknown) =>
        setProblem(`The switch was not saved: ${words(failure)}`),
      )
      .finally(() => setSaving(false));
  };

  return (
    <section aria-label="Sharing">
      <h3 className="mt-6 text-xs font-medium text-t3">Sharing</h3>
      <div className="flex items-center gap-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-t1">Share services that chats start</p>
          <p className="mt-0.5 text-xs text-t3">
            A service a chat starts on a port it chose, such as a development server, is shared with
            your paired devices once it has run for 5 seconds. Turned off, it is only listed in the
            Ports panel, where it can still be shared by hand. Services shared already stay shared.
          </p>
        </div>
        <Switch
          aria-label="Share services that chats start"
          checked={settings.autoShare}
          disabled={saving}
          onCheckedChange={save}
        />
      </div>
      {problem !== null && (
        <p role="alert" className="pb-2 text-xs text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}
