import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type BrowserFrame,
  type BrowserInput,
  BrowserPort,
  type BrowserStatus,
} from "@omp-app/contracts";
import { ArrowLeft, ArrowRight, Copy, Plus, RotateCw, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSidewaysRow } from "../../sidewaysRow";

const failureText = (failure: unknown): string =>
  failure instanceof AppFailure
    ? failure.appError.message
    : failure instanceof Error
      ? failure.message
      : String(failure);

/** The name and major version a relay extension reports ("Edg/151.0.3405.0" → "Edge 151"); others as they are. */
function browserName(reported: string | null): string {
  if (reported === null) return "your browser";
  const named = /^(Edg|Chrome)\/(\d+)/.exec(reported);
  if (named === null) return reported;
  return `${named[1] === "Edg" ? "Edge" : "Chrome"} ${named[2]}`;
}

/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/**
 * A key the page gets as the browser's own key event: the text it types (Enter types a carriage return, which submits
 * forms), or none for a key that only acts. Null for a key the app keeps: a lone modifier, one still composing, and the
 * paste key, whose paste brings this device's clipboard into the page as typed text (the page's own paste would read
 * the clipboard of the server's machine).
 */
export function keyInput(
  event: {
    readonly key: string;
    readonly code: string;
    readonly keyCode: number;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly isComposing: boolean;
  },
  type: "keyDown" | "keyUp",
): BrowserInput | null {
  if (event.isComposing || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return null;
  const pastes =
    ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v") ||
    (event.shiftKey && event.key === "Insert");
  if (pastes) return null;
  const types = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
  const text = event.key === "Enter" ? "\r" : types ? event.key : undefined;
  return {
    kind: "key",
    type,
    key: event.key.slice(0, 40),
    code: event.code.slice(0, 40),
    keyCode: Math.min(255, Math.max(0, event.keyCode)),
    modifiers: modifiersOf(event),
    ...(type === "keyDown" && text !== undefined ? { text } : {}),
  };
}

/**
 * The app's own browser (Browser and relay control, B3): a Chrome on the server's machine, its tabs, an address bar and
 * the shown page, live. A click, a tap, the wheel, a swipe and the keys go to the page as its own input; a phone types
 * through the field under the page. The page is drawn at the panel's size while the panel is open.
 */
export function BrowserPanel({ client }: { readonly client: AppClient }): ReactNode {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const pageRow = useSidewaysRow(shown);
  // "New page" puts the cursor in the address at once, like a browser's new tab, and an address entered before the page
  // is listed opens there; the panel shows the page once its list has it (the list can come after the open's answer), so
  // the address bar never goes in between.
  const opened = useRef<string | null>(null);
  const [opening, setOpening] = useState<Promise<string> | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [starting, setStarting] = useState(false);
  const read = useCallback(async () => {
    try {
      const next = await client.port(BrowserPort).status({});
      setStatus(next);
      setProblem(null);
      const { tabs, front } = next.app;
      const listed = (id: string | null): id is string =>
        id !== null && tabs.some((tab) => tab.id === id);
      const wanted = opened.current;
      if (listed(wanted)) {
        opened.current = null;
        setShown(wanted);
        setOpening(null);
        return;
      }
      // The panel shows the tab the browser has in front, the only one that draws and takes input: a page a chat opens
      // comes forward here too. A tab just opened is shown once the list has it.
      if (listed(front)) {
        setShown(front);
        return;
      }
      if (front !== null) return;
      // None is known to be in front (the browser just started, or the one in front closed): the one shown is brought
      // there.
      const chosen = listed(shownRef.current) ? shownRef.current : (tabs[0]?.id ?? null);
      setShown(chosen);
      if (chosen !== null)
        void client
          .port(BrowserPort)
          .show({ id: chosen })
          .catch(() => undefined);
    } catch (failure) {
      setProblem(
        failure instanceof AppFailure && failure.appError.code === "not_found"
          ? "This server has no browser yet: it needs the app's next update."
          : `Could not reach the app's browser: ${failureText(failure)}`,
      );
    }
  }, [client]);
  useEffect(() => {
    void read();
    let live = true;
    let stop: (() => void) | null = null;
    client
      .subscribe(BrowserPort, "changed", { onEvent: () => void read() })
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
  const act = (work: Promise<unknown>): void => {
    work.catch((failure: unknown) => setProblem(failureText(failure)));
  };

  if (status === null)
    return (
      <p data-tour="browser-panel" className="px-4 py-3 text-[0.8125rem] text-t3">
        {problem ?? "Looking for the app's browser…"}
      </p>
    );
  const { app } = status;
  const tab = app.tabs.find((candidate) => candidate.id === shown) ?? null;
  return (
    <section
      data-tour="browser-panel"
      aria-label="Browser"
      className="flex h-full min-h-0 flex-col"
    >
      {problem !== null && (
        <p role="alert" className="px-4 pt-2 text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <div className="flex flex-col gap-1.5 border-b border-l2 px-4 py-2 text-xs text-t2">
        <span>Chats use</span>
        {/* Three equal columns as wide as the panel: a name too long for its column takes two lines. */}
        <ToggleGroup
          aria-label="Chats use"
          size="sm"
          spacing={0.5}
          className="grid w-full grid-cols-3 rounded-lg border border-l2 p-0.5"
          value={[status.target]}
          onValueChange={(next) => {
            const picked = next[0];
            if (picked !== "off" && picked !== "app" && picked !== "edge") return;
            client
              .port(BrowserPort)
              .setTarget({ target: picked })
              .then(setStatus, (failure: unknown) => setProblem(failureText(failure)));
          }}
        >
          <ToggleGroupItem
            value="off"
            className="h-auto min-h-7 px-1.5 py-1 leading-tight whitespace-normal text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1"
          >
            omp's hidden one
          </ToggleGroupItem>
          <ToggleGroupItem
            value="app"
            disabled={!app.available}
            className="h-auto min-h-7 px-1.5 py-1 leading-tight whitespace-normal text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1"
          >
            The one shown here
          </ToggleGroupItem>
          <ToggleGroupItem
            value="edge"
            className="h-auto min-h-7 px-1.5 py-1 leading-tight whitespace-normal text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1"
          >
            Your own browser
          </ToggleGroupItem>
        </ToggleGroup>
        {/* What the chosen one is (#2797). */}
        <p className="text-t3">
          {status.target === "off"
            ? "A browser omp runs out of sight on the app's computer, signed in to nothing."
            : status.target === "app"
              ? "The browser below, on the app's computer: sign in to sites in it, and watch chats use it or take over."
              : "The browser on your own computer: Chrome, Edge or another Chromium browser with omp's relay extension, signed in as you."}
        </p>
      </div>
      {(status.target === "edge" || status.edge.problem !== null) && (
        <EdgeSection
          edge={status.edge}
          chosen={status.target === "edge"}
          onChoose={() =>
            client
              .port(BrowserPort)
              .setTarget({ target: "edge" })
              .then(setStatus, (failure: unknown) => setProblem(failureText(failure)))
          }
        />
      )}
      {!app.running ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="text-[0.8125rem] text-t2">
            {app.available
              ? "The app's own browser runs on the server's machine: you sign in to your sites in it, and your chats can use it."
              : (app.problem ?? "The app's browser is not available here.")}
          </p>
          {app.available && (
            <div>
              <Button
                size="sm"
                disabled={starting}
                onClick={() => {
                  setStarting(true);
                  client
                    .port(BrowserPort)
                    .start({})
                    .then(setStatus, (failure: unknown) => setProblem(failureText(failure)))
                    .finally(() => setStarting(false));
                }}
              >
                {starting ? "Starting…" : "Start the browser"}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* The app's own browser, labelled: with your own browser chosen, it is still here to use by hand. */}
          <div className="flex items-center border-b border-l2">
            <span className="shrink-0 pl-4 text-xs text-t3">The app's browser</span>
            <div
              ref={pageRow}
              role="tablist"
              aria-label="Pages"
              className="row-scroll flex min-w-0 flex-1 items-center gap-1 px-2 py-1"
            >
              {app.tabs.map((page) => (
                <div key={page.id} className="flex shrink-0 items-center">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={page.id === shown}
                    className={`max-w-40 truncate rounded px-2 py-1 text-xs ${page.id === shown ? "bg-l2 text-t1" : "text-t2 hover:bg-l1"}`}
                    onClick={() => {
                      setShown(page.id);
                      act(client.port(BrowserPort).show({ id: page.id }));
                    }}
                  >
                    {page.title || page.url || "New page"}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${page.title || "the page"}`}
                    className="rounded p-1 text-t3 hover:bg-l1"
                    onClick={() => act(client.port(BrowserPort).close({ id: page.id }))}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                aria-label="New page"
                className="shrink-0 rounded p-1 text-t2 hover:bg-l1"
                onClick={() => {
                  const page = client
                    .port(BrowserPort)
                    .open({ url: "" })
                    .then(({ id }) => {
                      opened.current = id;
                      void read();
                      return id;
                    });
                  setOpening(page);
                  setFocusTick((tick) => tick + 1);
                  page.catch((failure: unknown) => {
                    setOpening(null);
                    setProblem(failureText(failure));
                  });
                }}
              >
                <Plus className="size-4" />
              </button>
            </div>
          </div>
          <AddressBar
            client={client}
            id={tab?.id ?? null}
            url={tab?.url ?? ""}
            opening={opening}
            focusTick={focusTick}
            onFail={setProblem}
          />
          {tab !== null ? (
            <LiveView client={client} id={tab.id} title={tab.title} onFail={setProblem} />
          ) : (
            <p className="px-4 py-3 text-[0.8125rem] text-t3">No page is open.</p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * "Your own browser": the relay's state (none running yet, waiting for the browser with the line that links its
 * computer, or connected with its tabs), and how long it stays: until a time when chosen here, or until another browser
 * is chosen when set by hand.
 */
function EdgeSection({
  edge,
  chosen,
  onChoose,
}: {
  readonly edge: BrowserStatus["edge"];
  readonly chosen: boolean;
  /** Chooses your own browser again: starts the relay, and gives a choice made here 30 minutes more. */
  readonly onChoose: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const until =
    edge.until === null
      ? null
      : new Date(edge.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <section
      aria-label="Your own browser"
      className="flex flex-col gap-2 border-b border-l2 px-4 py-3 text-[0.8125rem]"
    >
      {edge.problem !== null ? (
        <p role="alert" className="text-bad-ink">
          {edge.problem}
        </p>
      ) : edge.connected ? (
        <>
          <p className="text-t1">
            Connected: {browserName(edge.browser)}. Chats drive its tabs; the ones they open are
            grouped as "omp".
          </p>
          <ul aria-label="Its tabs" className="flex flex-col gap-1">
            {edge.tabs.map((tab) => (
              <li key={tab.id} className="min-w-0">
                <span className={`block truncate ${tab.active ? "text-t1" : "text-t2"}`}>
                  {tab.title || tab.url}
                </span>
                <span className="block truncate text-xs text-t3">{tab.url}</span>
              </li>
            ))}
          </ul>
        </>
      ) : !edge.running ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-t2">
            No relay is running: it starts when a chat uses the browser, or now.
          </p>
          <Button size="sm" variant="secondary" onClick={onChoose}>
            Start the relay
          </Button>
        </div>
      ) : (
        <>
          <p className="text-t2">
            Waiting for your browser. On your computer, keep this running while chats use it (it
            carries the relay extension's connection to the app's computer):
          </p>
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 rounded bg-l1 px-2 py-1 text-xs break-words">
              {edge.link}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(edge.link).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 3_000);
                });
              }}
            >
              <Copy /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-t3">
            Your browser needs omp's relay extension (Chrome, Edge or another Chromium browser), on
            its usual port. While it is chosen, anything on the app's computer can drive it: put the
            extension in a profile of its own, signed in only to the sites chats should reach.
          </p>
        </>
      )}
      {until !== null ? (
        <div className="flex items-center gap-2 text-xs text-t3">
          <span>Turns itself off at {until}.</span>
          <Button size="sm" variant="ghost" onClick={onChoose}>
            30 minutes more
          </Button>
        </div>
      ) : (
        chosen && (
          <p className="text-xs text-t3">
            Set in omp's settings: chats use it until another browser is chosen here.
          </p>
        )
      )}
    </section>
  );
}

function AddressBar({
  client,
  id,
  url,
  opening,
  focusTick,
  onFail,
}: {
  readonly client: AppClient;
  /** The page shown; null when none is open, and an address entered then opens one. */
  readonly id: string | null;
  readonly url: string;
  /** The page "New page" is opening: an address entered before it is listed goes to it. */
  readonly opening: Promise<string> | null;
  /** Counts "New page" presses: each puts the cursor here. */
  readonly focusTick: number;
  readonly onFail: (text: string) => void;
}): ReactNode {
  const [typed, setTyped] = useState(url);
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const focused = useRef(focusTick);
  useEffect(() => {
    if (!editing && opening === null) setTyped(url === "about:blank" ? "" : url);
  }, [url, editing, opening]);
  // In the press's own commit, so the very next key lands here.
  useLayoutEffect(() => {
    if (focusTick === focused.current) return;
    focused.current = focusTick;
    setTyped("");
    field.current?.focus();
  }, [focusTick]);
  const go = (
    page: string,
    to: Parameters<ReturnType<typeof client.port<typeof BrowserPort>>["go"]>[0]["to"],
  ) => {
    client
      .port(BrowserPort)
      .go({ id: page, to })
      .catch((failure: unknown) => onFail(failureText(failure)));
  };
  const enter = (address: string) => {
    if (opening !== null) {
      // A failed open is already said in the panel.
      opening.then(
        (page) => go(page, { kind: "url", url: address }),
        () => undefined,
      );
    } else if (id === null) {
      client
        .port(BrowserPort)
        .open({ url: address })
        .catch((failure: unknown) => onFail(failureText(failure)));
    } else go(id, { kind: "url", url: address });
  };
  return (
    <form
      className="flex items-center gap-1 border-b border-l2 px-2 py-1"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (typed.trim() !== "") enter(typed.trim());
        setEditing(false);
        (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Back"
        disabled={id === null}
        onClick={() => id !== null && go(id, { kind: "back" })}
      >
        <ArrowLeft />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Forward"
        disabled={id === null}
        onClick={() => id !== null && go(id, { kind: "forward" })}
      >
        <ArrowRight />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Reload"
        disabled={id === null}
        onClick={() => id !== null && go(id, { kind: "reload" })}
      >
        <RotateCw />
      </Button>
      <input
        ref={field}
        aria-label="Address"
        value={typed}
        placeholder="Type an address"
        spellCheck={false}
        autoCapitalize="off"
        className="min-w-0 flex-1 rounded border border-l2 bg-transparent px-2 py-1 text-xs text-t1"
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onChange={(event) => setTyped(event.target.value)}
      />
    </form>
  );
}

/**
 * The shown page, live: its frames drawn into the panel, and the viewer's input sent back in the page's own pixels. A
 * touch tap is a click and a swipe scrolls; the field under the page types into it from a phone.
 */
function LiveView({
  client,
  id,
  title,
  onFail,
}: {
  readonly client: AppClient;
  readonly id: string;
  readonly title: string;
  readonly onFail: (text: string) => void;
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [typing, setTyping] = useState("");
  const send = useCallback(
    (input: BrowserInput) => {
      client
        .port(BrowserPort)
        .input({ id, input })
        .catch((failure: unknown) => onFail(failureText(failure)));
    },
    [client, id, onFail],
  );
  // The page is drawn at the panel's size.
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tell = () => {
      const width = Math.max(200, Math.round(element.clientWidth));
      const height = Math.max(200, Math.round(element.clientHeight));
      client
        .port(BrowserPort)
        .view({ id, width, height })
        .catch(() => undefined);
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(tell, 150);
    });
    observer.observe(element);
    tell();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [client, id]);
  // Its frames, while the panel shows it.
  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;
    setFrame(null);
    client
      .subscribe(BrowserPort, "frame", { scope: id, onEvent: (next) => live && setFrame(next) })
      .then((subscription) => {
        stop = () => void subscription.unsubscribe();
        if (!live) stop();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [client, id]);

  /** A point of the panel in the page's pixels. */
  const pageAt = (event: { clientX: number; clientY: number }) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect === undefined || frame === null) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * frame.width,
      y: ((event.clientY - rect.top) / rect.height) * frame.height,
    };
  };
  const touch = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const button = (event: PointerEvent) =>
    event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={box}
        role="application"
        aria-label={`Page: ${title || "new page"}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the live page is one widget (role application) that takes the keys
        tabIndex={0}
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          box.current?.focus();
          if (event.pointerType === "touch") {
            touch.current = { x: event.clientX, y: event.clientY, moved: false };
            return;
          }
          const at = pageAt(event);
          send({
            kind: "mouse",
            type: "mousePressed",
            ...at,
            button: button(event),
            clickCount: 1,
            modifiers: modifiersOf(event),
          });
        }}
        onPointerUp={(event: PointerEvent<HTMLDivElement>) => {
          const at = pageAt(event);
          if (event.pointerType === "touch") {
            const was = touch.current;
            touch.current = null;
            if (was === null || was.moved) return;
            send({
              kind: "mouse",
              type: "mousePressed",
              ...at,
              button: "left",
              clickCount: 1,
              modifiers: 0,
            });
            send({
              kind: "mouse",
              type: "mouseReleased",
              ...at,
              button: "left",
              clickCount: 1,
              modifiers: 0,
            });
            return;
          }
          send({
            kind: "mouse",
            type: "mouseReleased",
            ...at,
            button: button(event),
            clickCount: 1,
            modifiers: modifiersOf(event),
          });
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === "touch") {
            const was = touch.current;
            if (was === null) return;
            const deltaX = was.x - event.clientX;
            const deltaY = was.y - event.clientY;
            if (!was.moved && Math.hypot(deltaX, deltaY) < 8) return;
            touch.current = { x: event.clientX, y: event.clientY, moved: true };
            send({ kind: "wheel", ...pageAt(event), deltaX, deltaY, modifiers: 0 });
            return;
          }
          send({
            kind: "mouse",
            type: "mouseMoved",
            ...pageAt(event),
            button: event.buttons === 1 ? "left" : "none",
            clickCount: 0,
            modifiers: modifiersOf(event),
          });
        }}
        onWheel={(event) => {
          send({
            kind: "wheel",
            ...pageAt(event),
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            modifiers: modifiersOf(event),
          });
        }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          const input = keyInput(event.nativeEvent, "keyDown");
          if (input === null) return;
          event.preventDefault();
          event.stopPropagation();
          send(input);
        }}
        onKeyUp={(event: KeyboardEvent<HTMLDivElement>) => {
          const input = keyInput(event.nativeEvent, "keyUp");
          if (input === null) return;
          event.preventDefault();
          event.stopPropagation();
          send(input);
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          if (text === "") return;
          event.preventDefault();
          send({ kind: "text", text: text.slice(0, 10_000) });
        }}
      >
        {frame === null ? (
          <p className="p-4 text-xs text-t3">Drawing the page…</p>
        ) : (
          <img
            alt=""
            draggable={false}
            src={`data:image/jpeg;base64,${frame.data}`}
            className="pointer-events-none h-full w-full select-none object-fill"
          />
        )}
      </div>
      <form
        className="flex items-center gap-1 border-t border-l2 px-2 py-1"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (typing !== "") send({ kind: "text", text: typing });
          send({
            kind: "key",
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            text: "\r",
            modifiers: 0,
          });
          send({
            kind: "key",
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            modifiers: 0,
          });
          setTyping("");
        }}
      >
        <input
          aria-label="Type into the page"
          value={typing}
          placeholder="Type into the page, then Enter"
          autoCapitalize="off"
          className="min-w-0 flex-1 rounded border border-l2 bg-transparent px-2 py-1 text-xs text-t1"
          onChange={(event) => setTyping(event.target.value)}
        />
      </form>
    </div>
  );
}
