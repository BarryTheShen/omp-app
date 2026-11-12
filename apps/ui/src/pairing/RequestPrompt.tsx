import type { AppClient } from "@omp-app/client";
import { DevicesPort, type PairingRequest } from "@omp-app/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { notifyDesktop } from "../desktop/bridge";
import { DEVICE_KIND_WORDS } from "./device-name";
import { panelWarning } from "./framed-by";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** The requests to pair waiting for an answer, kept current by the devices port's `changed`; none on an older server. */
export function usePairingRequests(client: AppClient): readonly PairingRequest[] {
  const [requests, setRequests] = useState<readonly PairingRequest[]>([]);
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    client
      .port(DevicesPort)
      .list({})
      .then(
        (overview) => alive && setRequests(overview.requests),
        () => undefined,
      );
    client
      .subscribe(DevicesPort, "changed", {
        onEvent: (list) => {
          if (alive) setRequests(list.requests);
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
  return requests;
}

/**
 * On every paired page: a device asking to pair opens a prompt with its name and the 6 digits it shows, to allow or
 * deny; in the desktop window a notification says so too. Esc puts the prompt away (the request stays in Settings →
 * Devices); it closes by itself when the request is answered elsewhere or ends.
 */
export function RequestPrompt({ client }: { readonly client: AppClient }): ReactNode {
  const requests = usePairingRequests(client);
  const [putAway, setPutAway] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const told = useRef(new Set<string>());

  useEffect(() => {
    for (const request of requests) {
      if (told.current.has(request.id)) continue;
      told.current.add(request.id);
      if (!document.hasFocus()) {
        const notice = panelWarning(request);
        notifyDesktop(
          "A device wants to pair",
          `${request.name} shows ${request.code}${notice === null ? "" : `. ${notice}`}`,
        );
      }
    }
  }, [requests]);

  const request = requests.find((each) => !putAway.has(each.id));
  const warning = request === undefined ? null : panelWarning(request);
  const answer = (allow: boolean): void => {
    if (request === undefined) return;
    setPending(true);
    setProblem(null);
    const devices = client.port(DevicesPort);
    (allow ? devices.allow({ requestId: request.id }) : devices.deny({ requestId: request.id }))
      .catch((failure: unknown) => setProblem(failureText(failure)))
      .finally(() => setPending(false));
  };

  return (
    <AlertDialog
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open && request !== undefined) setPutAway((now) => new Set([...now, request.id]));
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>A device wants to pair</AlertDialogTitle>
          <AlertDialogDescription>
            {request?.name} ({request === undefined ? "" : DEVICE_KIND_WORDS[request.kind]}) asks to
            pair with this app. Allow it only if it shows these digits:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-center text-3xl font-medium tracking-wider text-t1 tabular-nums">
          {request === undefined ? "" : `${request.code.slice(0, 3)} ${request.code.slice(3)}`}
        </p>
        {warning !== null && <p className="text-sm font-medium text-t1">{warning}</p>}
        {problem !== null && (
          <p role="alert" className="text-sm text-bad-ink">
            {problem}
          </p>
        )}
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => answer(false)}>
            Deny
          </Button>
          <Button disabled={pending} onClick={() => answer(true)}>
            Allow
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
