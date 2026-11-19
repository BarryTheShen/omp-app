import type { AppClient } from "@omp-app/client";
import { type AccessState, DevicesPort } from "@omp-app/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Bridge, desktopBridge, refusalText } from "../../desktop/bridge";
import { clock, lengthText, timeLeft } from "./time";

/** What the desktop app says of agent access on its own computer (`access_here` in apps/desktop). */
interface Here {
  readonly installed: boolean;
  readonly setUp: boolean;
  readonly linked: { readonly server: string; readonly alias: string } | null;
  /** Linked to the server this window shows. */
  readonly here: boolean;
  /** The name agents will use for it. */
  readonly name: string;
}

/** What this computer's agent says of itself (`access_status`): the switch, and the review its guard holds. */
interface Status {
  readonly state: AccessState;
  readonly review: { readonly pending: boolean; readonly changed: readonly string[] };
}

/** What setup or remove did: what stands in the way, and each change made to the computer. */
interface Done {
  readonly title: string;
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly changes: readonly string[];
}

/** One agent session as this computer saw it: the commands it ran, and the text its terminal showed. */
interface Session {
  readonly stream: number;
  readonly commands: readonly { readonly text: string; readonly exit: string | null }[];
  readonly text: string;
}

/** The lengths offered, in minutes: one click each, the system asking the password. */
const ON_FOR = [30, 60, 120] as const;
const EXTEND_BY = [15, 30, 60] as const;
const SUDO_FOR = [5, 15, 30] as const;
/** The most of a session's terminal text kept on screen. */
const TEXT_KEPT = 60_000;
/** How often the panel asks this computer's agent what happened. */
const POLL_MS = 1_000;
/** What the panel says while a step waits: the setup's button shows its own. */
const SETTING_UP = "Setting up…";
const WAITING_FOR_PASSWORD = "Waiting for your password…";

const asHere = (value: unknown): Here | null =>
  typeof value === "object" && value !== null && "setUp" in value ? (value as Here) : null;

const asStatus = (value: unknown): Status | null =>
  typeof value === "object" && value !== null && "state" in value ? (value as Status) : null;

/**
 * A terminal's escape sequences (colours, cursor moves, titles) and its other control characters, line breaks and tabs
 * left alone: built from the characters' codes, as they are the terminal's own.
 */
const [ESC, BEL] = [String.fromCharCode(27), String.fromCharCode(7)];
const ESCAPES = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  "g",
);
const CONTROLS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

/** Characters that reorder the text around them (bidirectional overrides and isolates): shown, they could hide a part. */
const REORDERING = /[\u202A-\u202E\u2066-\u2069]/g;

/** A terminal's text as plain text: escape sequences, reordering and other control characters out, line breaks kept. */
export const plainTerminalText = (text: string): string =>
  text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "").replace(REORDERING, "");

/** A piece of output as bytes; nothing for one that is not base64 (the live view goes on). */
const outputBytes = (base64: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
};

function stateText(state: AccessState): string {
  if (!state.on) return "Off";
  const sudo = state.sudoUntil === null ? "" : ` · sudo until ${clock(state.sudoUntil)}`;
  const sessions = `${state.sessions} session${state.sessions === 1 ? "" : "s"}`;
  return `On · ${timeLeft(state.until)} · ${sessions}${sudo}`;
}

/** A labelled row of one-click lengths: the label above, the lengths on one line beneath it. */
function Lengths({
  label,
  lengths,
  disabled,
  onPick,
}: {
  readonly label: string;
  readonly lengths: readonly number[];
  readonly disabled: boolean;
  readonly onPick: (minutes: number) => void;
}): ReactNode {
  return (
    <fieldset aria-label={label} className="mt-3 min-w-0">
      <p className="text-xs text-t2">{label}</p>
      <div className="mt-1 flex gap-2">
        {lengths.map((minutes) => (
          <Button
            key={minutes}
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onPick(minutes)}
            className="max-sm:h-11"
          >
            {lengthText(minutes)}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

/** A button whose label may be longer than the side panel is wide: it wraps instead of being cut off. */
const WRAPS = "h-auto min-h-7 whitespace-normal py-1 text-left max-sm:min-h-11";

/**
 * Agent access on the computer this desktop window runs on (#20), all of it in the panel: one click sets it up (an
 * administrator's password, asked by the system) and links it to this window's server, with a one-time code this page
 * asks the server for; then the switch (on for a length, extend, sudo, off), the review the agent's guard holds after
 * an access, what each agent session runs and shows, and Remove. The desktop app acts only for a window showing the
 * server this computer is linked to, and the system asks the person's password for each grant, in a dialog whose words
 * the agent's guard writes. Nothing shows in a browser, or in a desktop app without agent access.
 */
export function ThisComputer({
  client,
  listed,
  onLinked,
  onAlias,
}: {
  readonly client: AppClient;
  /** The names of the computers this server lists. */
  readonly listed: readonly string[];
  /** The computer joined or left this server's list. */
  readonly onLinked: () => void;
  /** The name this computer is listed by here, or null: its row in the list leaves Remove to this section. */
  readonly onAlias: (alias: string | null) => void;
}): ReactNode {
  const [bridge] = useState<Bridge | null>(desktopBridge);
  const [here, setHere] = useState<Here | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  /** What is being done, as its button says it; null while nothing is. */
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [, setTick] = useState(0);
  const after = useRef(0);
  /** The sessions as last told, by stream; the shown list is a copy of these, newest first. */
  const told = useRef(new Map<number, Session>());
  /** Each session's own decoder: a character split between two pieces of output comes out whole. */
  const decoders = useRef(new Map<number, TextDecoder>());

  const read = useCallback(() => {
    if (bridge === null) return;
    bridge
      .invoke("access_here")
      .then((value) => setHere(asHere(value)))
      // A desktop app without agent access: nothing to show.
      .catch(() => setHere(null));
  }, [bridge]);

  useEffect(read, [read]);

  // This computer's own record says which server it is linked to; that server's list says whether it still is.
  const alias = here?.here === true ? (here.linked?.alias ?? null) : null;
  const linkedHere = alias !== null && listed.includes(alias);
  const forgotten = alias !== null && !linkedHere;

  useEffect(() => onAlias(linkedHere ? alias : null), [onAlias, linkedHere, alias]);

  const readStatus = useCallback(() => {
    bridge
      ?.invoke("access_status")
      .then((value) => setStatus(asStatus(value)))
      .catch((failure: unknown) => setFailed(refusalText(failure)));
  }, [bridge]);

  // While linked here: the switch's state, then what the agent tells, read on from where the panel left off.
  useEffect(() => {
    if (bridge === null || !linkedHere) return;
    readStatus();
    let live = true;
    const take = (events: unknown): void => {
      if (!live || !Array.isArray(events) || events.length === 0) return;
      let stateChanged = false;
      for (const { n, event } of events as { n: number; event: Record<string, unknown> }[]) {
        after.current = n;
        if (event.type === "state") stateChanged = true;
        if (event.type !== "wrapper") continue;
        const each = event.event as {
          type: string;
          stream: number;
          command?: string;
          startedAt?: string;
          bytes?: string;
          exitCode?: number | null;
        };
        const was = told.current.get(each.stream) ?? {
          stream: each.stream,
          commands: [],
          text: "",
        };
        let { commands, text } = was;
        if (each.type === "start") {
          const at = each.startedAt === undefined ? "" : `  (${clock(each.startedAt)})`;
          const command = (each.command ?? "").replace(REORDERING, "");
          commands = [...commands, { text: `${command}${at}`, exit: null }];
        } else if (each.type === "output" && each.bytes !== undefined) {
          let decoder = decoders.current.get(each.stream);
          if (decoder === undefined) {
            decoder = new TextDecoder();
            decoders.current.set(each.stream, decoder);
          }
          const bytes = outputBytes(each.bytes);
          text = (text + plainTerminalText(decoder.decode(bytes, { stream: true }))).slice(
            -TEXT_KEPT,
          );
        } else if (each.type === "end") {
          const last = commands.at(-1);
          if (last !== undefined)
            commands = [
              ...commands.slice(0, -1),
              { text: last.text, exit: String(each.exitCode ?? "?") },
            ];
        }
        told.current.set(each.stream, { stream: each.stream, commands, text });
      }
      // Newest session first.
      setSessions([...told.current.values()].sort((a, b) => b.stream - a.stream));
      if (stateChanged) readStatus();
    };
    // One read at a time: a slow answer never has a second read take the same events.
    let reading = false;
    const poll = setInterval(() => {
      if (reading) return;
      reading = true;
      bridge
        .invoke("access_events", { after: after.current })
        .then(take)
        .catch(() => undefined)
        .finally(() => {
          reading = false;
        });
    }, POLL_MS);
    // The minutes left count down without a word from the agent.
    const tick = setInterval(() => setTick((was) => was + 1), 30_000);
    return () => {
      live = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [bridge, linkedHere, readStatus]);

  if (bridge === null || here === null || !here.installed) return null;

  /** One of the switch's commands: the agent answers with its status. */
  const act = (command: string, saying: string, args?: Record<string, unknown>): void => {
    setBusy(saying);
    setFailed(null);
    bridge
      .invoke(command, args)
      .then((value) => setStatus(asStatus(value) ?? status))
      .catch((failure: unknown) => setFailed(refusalText(failure)))
      .finally(() => setBusy(null));
  };

  const finished = (title: string, answer: unknown): void => {
    const result = answer as Partial<Done>;
    setDone({
      title,
      ok: result.ok === true,
      problems: result.problems ?? [],
      changes: result.changes ?? [],
    });
  };

  const setUp = (): void => {
    setBusy(SETTING_UP);
    setDone(null);
    setFailed(null);
    client
      .port(DevicesPort)
      .newCode({})
      .then(({ code }) => bridge.invoke("access_set_up_here", { code }))
      .then((answer) => {
        finished("Setup is complete.", answer);
        onLinked();
      })
      .catch((failure: unknown) => setFailed(refusalText(failure)))
      .finally(() => {
        setBusy(null);
        read();
      });
  };

  const remove = (): void => {
    setRemoving(false);
    setBusy("Removing agent access…");
    setDone(null);
    setFailed(null);
    bridge
      .invoke("access_remove")
      .then((answer) => {
        finished("Agent access was removed.", answer);
        setStatus(null);
        told.current.clear();
        setSessions([]);
        onLinked();
      })
      .catch((failure: unknown) => setFailed(refusalText(failure)))
      .finally(() => {
        setBusy(null);
        read();
      });
  };

  const state = status?.state ?? null;
  const reviewing = status?.review.pending === true;
  const waiting = busy !== null;
  // Remove is for a computer linked here, forgotten here, or linked nowhere; one linked to another server is removed
  // from that server's window.
  const removable = here.setUp && (here.here || here.linked === null);

  return (
    <section aria-label="This computer" className="border-b border-l1 px-4 pt-1 pb-3">
      <h3 className="text-xs font-medium text-t3">This computer</h3>
      {linkedHere ? (
        <p className="mt-1 text-[0.8125rem] text-t2">
          <span className="font-medium text-t1">{alias}</span>
          {state === null ? "" : ` · ${stateText(state)}`}
        </p>
      ) : forgotten ? (
        <p className="mt-1 text-[0.8125rem] text-t2">
          <span className="font-medium text-t1">{alias}</span> was removed from this server, so its
          agents can no longer reach this computer. Link it again to restore access.
        </p>
      ) : (
        <p className="mt-1 text-[0.8125rem] text-t2">
          Allow this server's agents to work on this computer while agent access is turned on. Setup
          requires an administrator password once.
          {here.linked !== null &&
            ` This computer is currently linked to ${here.linked.server}; setting it up here links it to this server instead.`}
        </p>
      )}
      {linkedHere && reviewing && (
        <div className="mt-2 text-xs">
          <p className="text-t2">
            Review the changes made during the last session before turning access on again:
          </p>
          <ul aria-label="Changes to review" className="mt-1 list-disc pl-5 text-t3">
            {status?.review.changed.map((path) => (
              <li key={path} className="[overflow-wrap:anywhere]">
                {path.replace(REORDERING, "")}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            className="mt-2 max-sm:h-11"
            disabled={waiting}
            onClick={() => act("access_acknowledge", WAITING_FOR_PASSWORD)}
          >
            Mark as reviewed
          </Button>
        </div>
      )}
      {linkedHere && state !== null && !state.on && (
        <Lengths
          label="Turn on for"
          lengths={ON_FOR}
          disabled={waiting || reviewing}
          onPick={(minutes) => act("access_on", WAITING_FOR_PASSWORD, { minutes })}
        />
      )}
      {linkedHere && state?.on === true && (
        <>
          <div className="mt-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={waiting}
              onClick={() => act("access_off", "Turning off…")}
              className="max-sm:h-11"
            >
              Turn off
            </Button>
          </div>
          <Lengths
            label="Extend by"
            lengths={EXTEND_BY}
            disabled={waiting}
            onPick={(minutes) => act("access_extend", WAITING_FOR_PASSWORD, { minutes })}
          />
          {state.sudoUntil === null && (
            <Lengths
              label="Allow sudo for"
              lengths={SUDO_FOR}
              disabled={waiting}
              onPick={(minutes) => act("access_sudo", WAITING_FOR_PASSWORD, { minutes })}
            />
          )}
        </>
      )}
      {linkedHere && state !== null && (
        <p className="mt-2 text-xs text-t3">Each action requires your password.</p>
      )}
      {!linkedHere && (
        <div className="mt-2">
          <Button size="sm" disabled={waiting} onClick={setUp} className={WRAPS}>
            {busy === SETTING_UP
              ? busy
              : forgotten
                ? "Link this computer again"
                : "Set up agent access"}
          </Button>
        </div>
      )}
      {busy !== null && busy !== SETTING_UP && (
        <p role="status" className="mt-2 text-xs text-t2">
          {busy}
        </p>
      )}
      {failed !== null && (
        <p role="status" className="mt-2 text-xs text-bad-ink [overflow-wrap:anywhere]">
          {failed}
        </p>
      )}
      {linkedHere && sessions.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-medium text-t2">Agent sessions on this computer</h4>
          <ol aria-label="Agent sessions on this computer" className="mt-1 flex flex-col gap-2">
            {sessions.map((session) => (
              <li key={session.stream} className="rounded-md border border-l2 px-3 py-2">
                <p className="text-xs font-medium text-t2">Session {session.stream}</p>
                <ol className="mt-1 list-decimal pl-5 text-xs text-t3">
                  {session.commands.map((command, index) => (
                    // Commands only append: the place is the identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: an append-only list
                    <li key={index} className="[overflow-wrap:anywhere]">
                      <code>{command.text}</code>
                      {command.exit !== null && ` → exit code ${command.exit}`}
                    </li>
                  ))}
                </ol>
                {session.text !== "" && (
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-l1 p-2 text-[0.6875rem] text-t2 [overflow-wrap:anywhere]">
                    {session.text}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {removable && state?.on !== true && (
        <div className="mt-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={waiting}
            aria-expanded={removing}
            onClick={() => setRemoving(!removing)}
            className={WRAPS}
          >
            Remove agent access
          </Button>
          {/* The confirmation is a row of its own, away from Remove: a double click never lands on it. */}
          {removing && (
            <fieldset
              aria-label="Remove agent access from this computer?"
              className="mt-2 min-w-0 rounded-md border border-l2 px-3 py-2"
            >
              <p className="text-xs text-t2">
                Remove agent access from this computer? This server will no longer list it, and the
                account and settings created during setup will be deleted. An administrator password
                is required.
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="max-sm:h-11"
                  onClick={() => setRemoving(false)}
                >
                  Cancel
                </Button>
                <Button size="sm" variant="destructive" className="max-sm:h-11" onClick={remove}>
                  Remove
                </Button>
              </div>
            </fieldset>
          )}
        </div>
      )}
      {done !== null && (
        <div role="status" className="mt-2 text-xs [overflow-wrap:anywhere]">
          <p className={done.ok ? "text-t2" : "text-bad-ink"}>
            {done.ok
              ? done.problems.length > 0
                ? `${done.title} Resolve the following before turning access on:`
                : `${done.title} Changes made to this computer:`
              : "The operation did not complete:"}
          </p>
          {done.problems.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-bad-ink">
              {done.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {done.changes.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-t3">
              {done.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
