import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ListeningService,
  type Share,
  type SharesList,
  SharesPort,
} from "@omp-app/contracts";
import { ChevronDown, ChevronRight, Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useShareLink } from "../../shares/link";
import { fmtDuration } from "../../vendor/collab-web/lib/format";

const failureText = (failure: unknown): string =>
  failure instanceof AppFailure
    ? failure.appError.message
    : failure instanceof Error
      ? failure.message
      : String(failure);

/** An app server from before shares refuses their port as unknown. */
const isOlderServer = (failure: unknown): boolean =>
  failure instanceof AppFailure &&
  (failure.appError.code === "not_found" || failure.appError.code === "invalid_args");

/**
 * The services listening on the server's machine and the pages shared from it (#2788). A shared one opens on this device
 * through a one-time link; any other is shared with a click, except those on the never-share list. A service a chat
 * started on a port someone picked is shared by itself; one on a port handed out at random, or a debugger's, waits for a
 * click. Every share opens only on devices paired with the app. The chats' services and the shared ones come first;
 * every other listening port folds away under "Other services on this machine" (#2836).
 */
export function PortsPanel({ client }: { readonly client: AppClient }): ReactNode {
  const [list, setList] = useState<SharesList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [showOthers, setShowOthers] = useState(false);
  const read = useCallback(async () => {
    try {
      setList(await client.port(SharesPort).list({}));
      setProblem(null);
    } catch (failure) {
      setProblem(
        isOlderServer(failure)
          ? "This server can't share pages yet: it needs the app's next update."
          : `Could not list the services: ${failureText(failure)}`,
      );
    }
  }, [client]);
  useEffect(() => {
    void read();
    let live = true;
    let stop: (() => void) | null = null;
    client
      .subscribe(SharesPort, "changed", { onEvent: () => void read() })
      .then((subscription) => {
        stop = () => void subscription.unsubscribe();
        if (!live) stop();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [client, read]);
  const act = (work: Promise<unknown>, done: string): void => {
    work.then(
      () => {
        setSaid({ text: done, failed: false });
        void read();
      },
      (failure: unknown) => setSaid({ text: failureText(failure), failed: true }),
    );
  };

  if (problem !== null)
    return (
      <p data-tour="ports-panel" className="px-4 py-3 text-[0.8125rem] text-t3">
        {problem}
      </p>
    );
  if (list === null)
    return (
      <p data-tour="ports-panel" className="px-4 py-3 text-[0.8125rem] text-t3">
        Looking at the ports…
      </p>
    );
  const shareOf = (service: ListeningService): Share | undefined =>
    list.shares.find((share) => share.kind === "service" && share.port === service.port);
  const pages = list.shares.filter((share) => share.kind === "page");
  const ours = list.services.filter(
    (service) => service.threadId !== null || shareOf(service) !== undefined,
  );
  const others = list.services.filter(
    (service) => service.threadId === null && shareOf(service) === undefined,
  );
  const row = (service: ListeningService): ReactNode => {
    const share = shareOf(service);
    return (
      <li
        key={service.port}
        aria-label={`Port ${service.port}`}
        className="flex flex-col gap-1 border-b border-l1 px-4 py-2"
      >
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-[0.8125rem] text-t1">{service.port}</span>
          <span className="min-w-0 truncate text-[0.8125rem] text-t2">
            {service.program ?? "another user's program"}
          </span>
          {service.startedAt !== null && (
            <span className="ml-auto shrink-0 text-xs text-t3">
              running {fmtDuration(Date.now() - service.startedAt)}
            </span>
          )}
        </div>
        {service.threadId !== null && <span className="text-xs text-t3">Started by a chat</span>}
        {service.neverShare ? (
          <span className="text-xs text-t3">Never shared: it is on the never-share list.</span>
        ) : share === undefined ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={list.address === null}
              onClick={() =>
                act(
                  client.port(SharesPort).share({ port: service.port }),
                  `Port ${service.port} is shared.`,
                )
              }
            >
              Share
            </Button>
          </div>
        ) : (
          <SharedRow
            client={client}
            share={share}
            onStop={() => act(client.port(SharesPort).stop({ id: share.id }), "Stopped sharing.")}
          />
        )}
      </li>
    );
  };
  return (
    <section
      data-tour="ports-panel"
      aria-label="Ports"
      className="flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <p className="border-b border-l2 px-4 py-2 text-xs text-t3">
        {list.address === null
          ? "This machine has no Tailscale address, so nothing can be shared."
          : "Shared services and pages open only on devices paired with the app, each at an address of its own."}
      </p>
      {said !== null && (
        <p
          role={said.failed ? "alert" : "status"}
          className={`px-4 pt-2 text-xs ${said.failed ? "text-bad-ink" : "text-t3"}`}
        >
          {said.text}
        </p>
      )}
      <h3 className="px-4 pt-3 pb-1 font-medium text-t2 text-xs">
        Started by your chats, or shared
      </h3>
      {ours.length === 0 && (
        <p className="px-4 py-1 text-[0.8125rem] text-t3">
          No chat has started a service, and nothing is shared.
        </p>
      )}
      <ul className="flex flex-col">{ours.map(row)}</ul>
      {others.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showOthers}
            className="flex items-center gap-1 px-4 pt-3 pb-1 text-left font-medium text-t2 text-xs hover:text-t1 max-sm:min-h-11 tablet:min-h-11"
            onClick={() => setShowOthers((shown) => !shown)}
          >
            {showOthers ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            Other services on this machine ({others.length})
          </button>
          {showOthers && <ul className="flex flex-col">{others.map(row)}</ul>}
        </>
      )}
      {pages.length > 0 && (
        <>
          <h3 className="px-4 pt-3 pb-1 font-medium text-t2 text-xs">Pages</h3>
          <ul className="flex flex-col">
            {pages.map((share) => (
              <li
                key={share.id}
                aria-label={share.path ?? "Page"}
                className="flex flex-col gap-1 border-b border-l1 px-4 py-2"
              >
                <span className="min-w-0 truncate text-[0.8125rem] text-t1">{share.path}</span>
                <SharedRow
                  client={client}
                  share={share}
                  onStop={() =>
                    act(client.port(SharesPort).stop({ id: share.id }), "Stopped sharing.")
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * A shared service or page: Open (a one-time link for this device), Copy link, Stop sharing, and who opened it; once the
 * share ended, a line that says so instead (#2836).
 */
function SharedRow({
  client,
  share,
  onStop,
}: {
  readonly client: AppClient;
  readonly share: Share;
  readonly onStop: () => void;
}): ReactNode {
  const { url, used, ended } = useShareLink(client, share.id);
  const [copied, setCopied] = useState(false);
  if (ended)
    return (
      <span className="text-xs text-t3">
        {share.kind === "service" ? "This share ended: the service stopped." : "This share ended."}
      </span>
    );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {url === null ? (
          <Button size="sm" variant="secondary" disabled>
            <ExternalLink /> Open
          </Button>
        ) : (
          // A link, not a window opened after an answer: nothing holds it back as a popup.
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={used}
            className={buttonVariants({ size: "sm", variant: "secondary" })}
          >
            <ExternalLink /> Open
          </a>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={url === null}
          onClick={() => {
            if (url === null) return;
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true);
              used();
              setTimeout(() => setCopied(false), 4_000);
            });
          }}
        >
          <Copy /> {copied ? "Copied: it works once, within a minute" : "Copy link"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onStop}>
          Stop sharing
        </Button>
      </div>
      <span className="text-xs text-t3">
        {share.automatic ? "Shared by itself. " : ""}
        {share.openedBy.length > 0 ? `Opened on ${share.openedBy.join(", ")}.` : "Not opened yet."}
      </span>
    </div>
  );
}
