import type { AppClient } from "@omp-app/client";
import { type PushDevice, PushPort } from "@omp-app/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { desktopBridge } from "../desktop/bridge";
import {
  currentSubscription,
  disablePush,
  enablePush,
  needsHomeScreen,
  pushSupported,
} from "./push";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * Settings → App → Notifications: this device gets the app's own notifications (a question waiting, a turn done while
 * no window shows the chat), and tapping one opens the app at that chat. On an iPhone only the Home Screen app can; the
 * desktop window raises its own. Lists the other devices that get them, each removable.
 */
export function PushSection({ client }: { readonly client: AppClient }): ReactNode {
  const supported = pushSupported();
  const [mine, setMine] = useState<string | null | undefined>(undefined);
  const [devices, setDevices] = useState<readonly PushDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void currentSubscription().then(
      (subscription) => alive && setMine(subscription?.endpoint ?? null),
    );
    client
      .port(PushPort)
      .devices({})
      .then(
        (listed) => alive && setDevices(listed.devices),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [client]);

  const turn = (on: boolean): void => {
    setBusy(true);
    setProblem(null);
    setSaid(null);
    // Called straight from the tap: the system asks for the permission only then.
    (on ? enablePush(client) : disablePush(client))
      .then(async () => {
        setMine((await currentSubscription())?.endpoint ?? null);
        setDevices((await client.port(PushPort).devices({})).devices);
      })
      .catch((failure: unknown) => setProblem(words(failure)))
      .finally(() => setBusy(false));
  };
  const test = (): void => {
    if (mine === null || mine === undefined) return;
    setProblem(null);
    client
      .port(PushPort)
      .test({ endpoint: mine })
      .then(
        (result) =>
          setSaid(
            result.sent > 0
              ? "Sent: it shows in a moment."
              : "The device's push service did not take it.",
          ),
        (failure: unknown) => setProblem(words(failure)),
      );
  };
  const remove = (id: string): void => {
    client
      .port(PushPort)
      .unsubscribe({ id })
      .then(
        (listed) => setDevices(listed.devices),
        (failure: unknown) => setProblem(words(failure)),
      );
  };

  return (
    <section aria-label="Notifications">
      <h3 className="mt-6 text-xs font-medium text-t3">Notifications</h3>
      {desktopBridge() !== null ? (
        <p className="mt-2 text-sm text-t2">
          This desktop app shows its own notifications while its window is in the background.
        </p>
      ) : !supported ? (
        <p className="mt-2 text-sm text-t2">
          {needsHomeScreen()
            ? "On an iPhone or iPad, add the app to the Home Screen (Share → Add to Home Screen) and open it from there: only the Home Screen app gets notifications that open it."
            : "This browser cannot get the app's notifications."}
        </p>
      ) : (
        <div className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-t1">Notifications on this device</p>
            <p className="mt-0.5 text-xs text-t3">
              A question waiting for you, or a turn done while no window shows its chat. Tapping one
              opens the app at that chat.
            </p>
          </div>
          {mine !== null && mine !== undefined && (
            <Button size="sm" variant="ghost" onClick={test}>
              Send a test
            </Button>
          )}
          <Switch
            aria-label="Notifications on this device"
            checked={mine !== null && mine !== undefined}
            disabled={busy || mine === undefined}
            onCheckedChange={turn}
          />
        </div>
      )}
      {said !== null && (
        <p role="status" className="text-xs text-t2">
          {said}
        </p>
      )}
      {devices.length > 0 && (
        <ul aria-label="Devices that get notifications" className="mt-1 flex flex-col">
          {devices.map((each) => (
            <li key={each.id} className="flex items-center gap-3 py-1.5 text-sm text-t2">
              <span className="min-w-0 flex-1 truncate">{each.device}</span>
              <Button size="xs" variant="ghost" className="text-t3" onClick={() => remove(each.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problem !== null && (
        <p role="alert" className="mt-1 text-sm text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}
