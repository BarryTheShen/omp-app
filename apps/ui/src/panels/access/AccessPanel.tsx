import type { AppClient } from "@omp-app/client";
import {
  type AccessActivity,
  type AccessMachine,
  AppFailure,
  DeviceAccessPort,
  type FolderPath,
  type ThreadId,
} from "@omp-app/contracts";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatTarget } from "../../chat/controller";
import { ThisComputer } from "./ThisComputer";
import { clock, timeLeft } from "./time";

type OpenChat = ((target: ChatTarget) => void) | undefined;

const failureText = (failure: unknown): string =>
  failure instanceof AppFailure
    ? failure.appError.message
    : failure instanceof Error
      ? failure.message
      : String(failure);

/** A server without agent access (an older one, or one where it is not switched on) refuses its port as unknown. */
const isOff = (failure: unknown): boolean =>
  failure instanceof AppFailure &&
  (failure.appError.code === "not_found" || failure.appError.code === "invalid_args");

/** The most recent things that ran, as the panel keeps them while open. */
const FEED_KEPT = 200;

/**
 * One row per run: the machine sends a record when a command starts and the same record (same `seq`) when it ends, and
 * the history keeps both. The finished one is shown, in the place of the first.
 */
function oneRowPerRun(activity: readonly AccessActivity[]): AccessActivity[] {
  const rows = new Map<string, AccessActivity>();
  for (const each of activity) {
    const key = `${each.record.machineId}-${each.record.seq}`;
    const kept = rows.get(key);
    if (kept === undefined || (kept.record.endedAt === null && each.record.endedAt !== null))
      rows.set(key, each);
  }
  return [...rows.values()];
}

function stateText(machine: AccessMachine): string {
  if (machine.state.on) {
    const sessions = machine.state.sessions;
    const sudo =
      machine.state.sudoUntil === null ? "" : ` · sudo until ${clock(machine.state.sudoUntil)}`;
    return `On · ${timeLeft(machine.state.until)} · ${sessions} session${sessions === 1 ? "" : "s"}${sudo}`;
  }
  if (machine.reviewPending) return "Off · review required on the computer";
  return machine.lastSeenAt === null
    ? "Off · never connected"
    : `Off · last connected ${new Date(machine.lastSeenAt).toLocaleString()}`;
}

/** One thing that ran: its command line, where, when, how it ended, and whether the machine's signature checked out. */
function ActivityRow({
  activity,
  alias,
  openChat,
}: {
  readonly activity: AccessActivity;
  readonly alias: string | undefined;
  readonly openChat: OpenChat;
}): ReactNode {
  const { threadId } = activity;
  const { record } = activity;
  const seconds =
    record.endedAt === null
      ? 0
      : Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000));
  // No exit code: its session was cut off or access turned off while it ran.
  const ended =
    record.endedAt === null
      ? "running"
      : record.exitCode === null
        ? `ended with its session · ${seconds} s`
        : `exit code ${record.exitCode} · ${seconds} s`;
  return (
    <li className="flex flex-col gap-0.5 border-b border-l1 px-4 py-2">
      <code className="font-mono text-[0.75rem] text-t1 [overflow-wrap:anywhere]">
        {record.command}
      </code>
      <span className="text-xs text-t3">
        {alias ?? "Unknown computer"} · {new Date(record.startedAt).toLocaleTimeString()} · {ended}
        {record.sudo ? " · sudo allowed" : ""}
        {activity.threadId === null ? " · not from a chat" : ""}
      </span>
      {!activity.verified && (
        <span className="flex items-center gap-1 text-xs text-bad-ink">
          <CircleAlert aria-hidden className="size-3.5" />
          The computer's signature could not be verified; this record may be inaccurate.
        </span>
      )}
      {threadId !== null && openChat !== undefined && (
        <button
          type="button"
          className="self-start text-xs text-accent-ink underline-offset-2 hover:underline max-sm:min-h-11"
          onClick={() =>
            openChat({ kind: "existing", threadId: threadId as ThreadId, sessionFile: null })
          }
        >
          Open the chat
        </button>
      )}
    </li>
  );
}

/**
 * Agent access (#20): the computers agents may reach through the app, each one's switch as the computer says it, and
 * what ran on them. Any page may turn a computer off; turning one on happens only on that computer, with its owner's
 * password. Command lines, results and times only: what a session's terminal shows stays on the computer.
 */
export function AccessPanel({
  client,
  folder,
  current,
  openChat,
}: {
  readonly client: AppClient;
  /** The workspace whose recent chats this computer's section offers to give access. */
  readonly folder: FolderPath;
  /** The chat open beside the panel. */
  readonly current: ThreadId | null;
  readonly openChat?: (target: ChatTarget) => void;
}): ReactNode {
  const [machines, setMachines] = useState<readonly AccessMachine[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [feed, setFeed] = useState<readonly AccessActivity[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly AccessActivity[]>([]);
  /** The computer whose Remove was clicked once: a second click forgets it. */
  const [removing, setRemoving] = useState<string | null>(null);
  /** The name the computer this desktop window runs on is listed by: its Remove is in "This computer" above. */
  const [thisComputer, setThisComputer] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      setMachines((await client.port(DeviceAccessPort).list({})).machines);
      setProblem(null);
    } catch (failure) {
      setProblem(
        isOff(failure)
          ? "Agent access is not enabled on this server."
          : `The computers could not be listed: ${failureText(failure)}`,
      );
    }
  }, [client]);

  useEffect(() => {
    void read();
    let live = true;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => {
      if (live) stops.push(stop);
      else stop();
    };
    client
      .subscribe(DeviceAccessPort, "changed", {
        onEvent: (payload) => setMachines((payload as { machines: AccessMachine[] }).machines),
      })
      .then((subscription) => keep(() => void subscription.unsubscribe()))
      .catch(() => undefined);
    client
      .subscribe(DeviceAccessPort, "activity", {
        onEvent: (payload) => {
          const activity = payload as AccessActivity;
          setFeed((was) => {
            // A finished record replaces the same record's start.
            const rest = was.filter(
              (each) =>
                !(
                  each.record.machineId === activity.record.machineId &&
                  each.record.seq === activity.record.seq
                ),
            );
            return [activity, ...rest].slice(0, FEED_KEPT);
          });
        },
      })
      .then((subscription) => keep(() => void subscription.unsubscribe()))
      .catch(() => undefined);
    // The minutes left count down without a change from the server.
    const tick = setInterval(() => setMachines((was) => (was === null ? was : [...was])), 30_000);
    return () => {
      live = false;
      clearInterval(tick);
      for (const stop of stops) stop();
    };
  }, [client, read]);

  const toggle = (machineId: string): void => {
    if (open === machineId) {
      setOpen(null);
      return;
    }
    setOpen(machineId);
    setHistory([]);
    client
      .port(DeviceAccessPort)
      .history({ machineId, limit: 100 })
      .then(({ activity }) => setHistory(oneRowPerRun(activity)))
      .catch((failure: unknown) => setSaid({ text: failureText(failure), failed: true }));
  };

  const turnOff = (machine: AccessMachine): void => {
    client
      .port(DeviceAccessPort)
      .off({ machineId: machine.id })
      .then(
        ({ sent }) =>
          setSaid({
            text: sent ? `${machine.alias} is turning off.` : `${machine.alias} is already off.`,
            failed: false,
          }),
        (failure: unknown) => setSaid({ text: failureText(failure), failed: true }),
      );
  };

  const remove = (machine: AccessMachine): void => {
    setRemoving(null);
    client
      .port(DeviceAccessPort)
      .remove({ machineId: machine.id })
      .then(
        ({ machines: left }) => {
          setMachines(left);
          if (open === machine.id) setOpen(null);
          setSaid({
            text: `${machine.alias} was removed from this server; its keys no longer work.`,
            failed: false,
          });
        },
        (failure: unknown) => setSaid({ text: failureText(failure), failed: true }),
      );
  };

  if (problem !== null)
    return (
      <p data-tour="access-panel" className="px-4 py-3 text-[0.8125rem] text-t3">
        {problem}
      </p>
    );
  if (machines === null)
    return (
      <p data-tour="access-panel" className="px-4 py-3 text-[0.8125rem] text-t3">
        Loading computers…
      </p>
    );
  const aliasOf = (machineId: string) => machines.find((each) => each.id === machineId)?.alias;
  return (
    <div data-tour="access-panel" className="flex flex-col">
      <p className="px-4 pt-3 pb-2 text-xs text-t3">
        Agents can reach a computer only while agent access is on. Access can be turned on only at
        the computer itself, in this panel of its desktop app or with <code>omp-app-device on</code>
        . It can be turned off from any device.
      </p>
      <ThisComputer
        client={client}
        folder={folder}
        current={current}
        listed={machines.map((machine) => machine.alias)}
        onLinked={() => {
          // A notice about this computer ("… was removed") is stale once it is linked again.
          setSaid(null);
          void read();
        }}
        onAlias={setThisComputer}
      />
      {said !== null && (
        <p
          role="status"
          className={`px-4 pb-2 text-xs ${said.failed ? "text-bad-ink" : "text-t2"}`}
        >
          {said.text}
        </p>
      )}
      {machines.length === 0 ? (
        <p className="px-4 py-2 text-[0.8125rem] text-t3">
          No computers are linked. On a computer with the desktop app, use Set up agent access
          above. On a server, run <code>omp-app-device enroll</code> with a one-time code from
          Settings → App → Devices.
        </p>
      ) : (
        <ul aria-label="Computers" className="border-t border-l1">
          {machines.map((machine) => (
            <li key={machine.id} className="border-b border-l1">
              <div className="flex items-center gap-2 px-4 py-2">
                <button
                  type="button"
                  aria-expanded={open === machine.id}
                  aria-label={`${machine.alias}: what ran`}
                  onClick={() => toggle(machine.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left max-sm:min-h-11"
                >
                  {open === machine.id ? (
                    <ChevronDown aria-hidden className="size-3.5 shrink-0 text-t3" />
                  ) : (
                    <ChevronRight aria-hidden className="size-3.5 shrink-0 text-t3" />
                  )}
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${machine.state.on ? "bg-bad" : "bg-l2"}`}
                  />
                  <span className="truncate font-medium text-[0.8125rem] text-t1">
                    {machine.alias}
                  </span>
                </button>
                {machine.state.on ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="max-sm:h-11"
                    onClick={() => turnOff(machine)}
                  >
                    Turn off
                  </Button>
                ) : machine.alias === thisComputer ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="max-sm:h-11"
                    aria-expanded={removing === machine.id}
                    onClick={() => setRemoving(removing === machine.id ? null : machine.id)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {/* The confirmation is a row of its own, away from Remove: a double click, or a second click meant for
                  something else, never lands on it (one removed a laptop by accident, 2026-11-19). */}
              {removing === machine.id && !machine.state.on && (
                <fieldset
                  aria-label={`Remove ${machine.alias}?`}
                  className="mx-4 mb-2 min-w-0 rounded-md border border-l2 px-3 py-2"
                >
                  <p className="text-xs text-t2">
                    Remove {machine.alias} from this server? Its keys stop working immediately, and
                    agents cannot reach it until it is linked again at the computer.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="max-sm:h-11"
                      onClick={() => setRemoving(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="max-sm:h-11"
                      onClick={() => remove(machine)}
                    >
                      Remove {machine.alias}
                    </Button>
                  </div>
                </fieldset>
              )}
              <p className="px-4 pb-2 text-xs text-t3">{stateText(machine)}</p>
              {machine.state.on && machine.reach.length > 0 && (
                <p className="px-4 pb-2 text-xs text-t3 [overflow-wrap:anywhere]">
                  Reachable from this computer: {machine.reach.join("; ")}
                </p>
              )}
              {open === machine.id && (
                <ul aria-label={`What ran on ${machine.alias}`} className="border-t border-l1">
                  {history.length === 0 ? (
                    <li className="px-4 py-2 text-xs text-t3">
                      No commands have run on this computer.
                    </li>
                  ) : (
                    history.map((activity) => (
                      <ActivityRow
                        key={`${activity.record.seq}-${activity.record.endedAt ?? "running"}`}
                        activity={activity}
                        alias={machine.alias}
                        openChat={openChat}
                      />
                    ))
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-t2">Recent activity</h3>
      {feed.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-t3">No activity since this panel was opened.</p>
      ) : (
        <ul aria-label="What ran" className="border-t border-l1">
          {feed.map((activity) => (
            <ActivityRow
              key={`${activity.record.machineId}-${activity.record.seq}`}
              activity={activity}
              alias={aliasOf(activity.record.machineId)}
              openChat={openChat}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
