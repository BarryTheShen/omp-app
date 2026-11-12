import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type DeviceOverview,
  DevicesPort,
  formatPairingCode,
  type PairedDevice,
  type PairingCode,
  pairingLink,
} from "@omp-app/contracts";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEVICE_KIND_WORDS } from "../pairing/device-name";
import { panelInside, panelWarning } from "../pairing/framed-by";
import { Qr } from "../pairing/Qr";
import { relTime } from "../vendor/collab-web/lib/format";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * Settings → App → Devices: the devices paired with the app (rename, remove), the requests waiting, and a one-time code
 * with its QR code for a new device.
 */
export function Devices({ client }: { readonly client: AppClient }): ReactNode {
  const [overview, setOverview] = useState<DeviceOverview | null>(null);
  const [older, setOlder] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState<PairingCode | null>(null);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    const devices = client.port(DevicesPort);
    devices.list({}).then(
      (next) => alive && setOverview(next),
      (failure: unknown) => {
        if (!alive) return;
        // A server before pairing has no devices port, and says so as not found.
        if (failure instanceof AppFailure && failure.appError.code === "not_found") setOlder(true);
        else setProblem(`Could not read the devices: ${failureText(failure)}`);
      },
    );
    client
      .subscribe(DevicesPort, "changed", {
        onEvent: (list) => {
          if (alive) setOverview((now) => (now === null ? now : { ...now, ...list }));
        },
      })
      .then(
        (subscription) => {
          if (alive) stop = () => void subscription.unsubscribe();
          else void subscription.unsubscribe();
        },
        () => undefined,
      );
    return () => {
      alive = false;
      stop?.();
    };
  }, [client]);

  const act = (run: () => Promise<DeviceOverview>): void => {
    setProblem(null);
    run().then(setOverview, (failure: unknown) => setProblem(failureText(failure)));
  };
  const newCode = (): void => {
    setProblem(null);
    client
      .port(DevicesPort)
      .newCode({})
      .then(setCode, (failure: unknown) => setProblem(failureText(failure)));
  };

  return (
    <section aria-label="Devices" data-tour="devices">
      <h3 className="mt-6 text-xs font-medium text-t3">Devices</h3>
      <p className="mt-2 text-sm text-t2">
        Each device that opens the app is paired once, and stays paired until you remove it here.
      </p>
      {older ? (
        <p className="py-3 text-sm text-t3">
          This app server cannot pair devices yet; it needs an update.
        </p>
      ) : overview === null ? (
        <p className="py-3 text-sm text-t3">{problem ?? "Reading the devices…"}</p>
      ) : (
        <>
          {overview.requests.length > 0 && (
            <ul aria-label="Asking to pair" className="mt-3 flex flex-col">
              {overview.requests.map((request) => (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center gap-3 border-b border-l1 py-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-t1">
                      {request.name} asks to pair, showing{" "}
                      <span className="font-medium tabular-nums">
                        {request.code.slice(0, 3)} {request.code.slice(3)}
                      </span>
                    </span>
                    {panelWarning(request) !== null && (
                      <p className="mt-0.5 text-xs text-t2">{panelWarning(request)}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      act(() => client.port(DevicesPort).deny({ requestId: request.id }))
                    }
                  >
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      act(() => client.port(DevicesPort).allow({ requestId: request.id }))
                    }
                  >
                    Allow
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {overview.devices.length === 0 ? (
            <p className="py-3 text-sm text-t3">
              No device is paired yet. This page was opened with the app's link.
            </p>
          ) : (
            <ul aria-label="Paired devices" className="mt-1 flex flex-col">
              {overview.devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  current={device.id === overview.thisDeviceId}
                  onRename={(name) =>
                    act(() => client.port(DevicesPort).rename({ deviceId: device.id, name }))
                  }
                  onRemove={() =>
                    act(() => client.port(DevicesPort).remove({ deviceId: device.id }))
                  }
                />
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-col items-start gap-3">
            <Button size="sm" variant="outline" data-tour="pair-new-device" onClick={newCode}>
              {code === null ? "Pair a new device" : "New code"}
            </Button>
            {code !== null && (
              <section aria-label="One-time code" className="flex flex-wrap items-center gap-5">
                <Qr
                  text={pairingLink(code.address, code.code)}
                  label={`QR code that opens the app and pairs with code ${formatPairingCode(code.code)}`}
                />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <p className="font-mono text-2xl tracking-wider text-t1">
                    {formatPairingCode(code.code)}
                  </p>
                  <p className="text-sm text-t2">
                    On the new device, open {code.address} and enter this code, or scan the QR code.
                  </p>
                  <p className="text-xs text-t3">It works once, for 10 minutes.</p>
                </div>
              </section>
            )}
          </div>
        </>
      )}
      {problem !== null && overview !== null && (
        <p role="alert" className="mt-2 text-sm text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}

function DeviceRow({
  device,
  current,
  onRename,
  onRemove,
}: {
  readonly device: PairedDevice;
  readonly current: boolean;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (editing === null || editing.trim() === "") return;
    onRename(editing.trim());
    setEditing(null);
  };
  const seen =
    device.lastSeenAt === null
      ? "Not connected yet"
      : `Last seen ${relTime(Date.parse(device.lastSeenAt))}`;
  return (
    <li
      aria-label={device.name}
      className="flex flex-wrap items-center gap-3 border-b border-l1 py-3"
    >
      {editing === null ? (
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm text-t1">
            <span className="min-w-0 truncate">{device.name}</span>
            {current && <span className="shrink-0 text-xs text-ok-ink">This device</span>}
          </p>
          <p className="mt-0.5 text-xs text-t3">
            {DEVICE_KIND_WORDS[device.kind]} · Paired {day.format(Date.parse(device.pairedAt))} ·{" "}
            {seen}
          </p>
          {panelInside(device) !== null && (
            <p className="mt-0.5 text-xs text-t3">In a panel inside {panelInside(device)}</p>
          )}
        </div>
      ) : (
        <form onSubmit={save} className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            aria-label="Device name"
            value={editing}
            maxLength={60}
            onChange={(event) => setEditing(event.target.value)}
          />
          <Button type="submit" size="sm">
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
        </form>
      )}
      {editing === null && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setEditing(device.name)}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </>
      )}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {device.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {current
                ? "This is the device you are using: its windows close, and it pairs again to come back."
                : "Its windows close, and it pairs again to come back."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setRemoving(false);
                onRemove();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
