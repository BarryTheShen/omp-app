import { formatPairingCode, normalizePairingCode, type PairingAsked } from "@omp-app/contracts";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { embed } from "../lite/embed";
import { guessThisDevice } from "./device-name";
import { askToPair, claimPairing, enterPairingCode } from "./pairing-api";

/** How often the screen asks whether its request was answered. */
const CLAIM_EVERY_MS = 1_500;

type AskState =
  | { readonly kind: "idle" }
  | { readonly kind: "asking" }
  | { readonly kind: "waiting"; readonly asked: PairingAsked }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" };

/** The digits as shown: "482 913". */
const spaced = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** A panel whose host keeps its key (`/lite?embed=1`) asks for it with the answer that pairs. */
const keep = embed?.keepsCredential === true ? "host" : null;

/**
 * Into the app: the address loses the pairing code (its query, a panel's settings, stays), and the page loads again,
 * signed in by its new key: a cookie, or for a panel whose host keeps it, the key the host is handed first.
 */
function openApp(key: string | undefined): void {
  if (key !== undefined) embed?.keepCredential(key);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  window.location.reload();
}

/**
 * The page of a device that is not paired: it asks a paired device to allow it, showing the 6 digits that device's
 * prompt shows, or it takes a one-time code (typed, or from a QR code's address `/#pair=<code>`).
 */
export function PairingScreen({
  linkRefused,
  scannedCode,
}: {
  readonly linkRefused: boolean;
  /** The one-time code of the QR code this page was opened from, taken out of its address. */
  readonly scannedCode: string | null;
}): ReactNode {
  const guess = useRef(guessThisDevice());
  const nameId = useId();
  const codeId = useId();
  const [name, setName] = useState(guess.current.name);
  const fromQr = useRef(scannedCode);
  const [mode, setMode] = useState<"ask" | "code">(fromQr.current === null ? "ask" : "code");
  const [ask, setAsk] = useState<AskState>({ kind: "idle" });
  const [code, setCode] = useState(fromQr.current ?? "");
  const [codeNote, setCodeNote] = useState<ReactNode>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // While a request waits, the screen asks whether it was answered, 1.5 s after each answer: one question at a time, so
  // a slow answer never overtakes the one that pairs.
  const waitingFor = ask.kind === "waiting" ? ask.asked.requestId : null;
  useEffect(() => {
    if (waitingFor === null) return;
    let alive = true;
    let timer = 0;
    const askAgain = (): void => {
      timer = window.setTimeout(() => {
        void claimPairing(waitingFor, keep).then((answer) => {
          if (!alive) return;
          if (!answer.ok) setProblem(answer.message);
          else {
            setProblem(null);
            const claimed = answer.value;
            if (claimed.status === "paired") {
              alive = false;
              openApp(claimed.key);
              return;
            }
            if (claimed.status === "denied" || claimed.status === "expired") {
              setAsk({ kind: claimed.status });
              return;
            }
          }
          askAgain();
        });
      }, CLAIM_EVERY_MS);
    };
    askAgain();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [waitingFor]);

  const startAsking = (): void => {
    setProblem(null);
    setAsk({ kind: "asking" });
    void askToPair(name.trim(), guess.current.kind).then((answer) => {
      if (answer.ok) setAsk({ kind: "waiting", asked: answer.value });
      else {
        setAsk({ kind: "idle" });
        setProblem(answer.message);
      }
    });
  };

  const submitCode = (event?: FormEvent): void => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setCodeNote(null);
    void enterPairingCode(normalizePairingCode(code), name.trim(), guess.current.kind, keep)
      .then((answer) => {
        if (!answer.ok) {
          setProblem(answer.message);
          return;
        }
        const entered = answer.value;
        if (entered.status === "paired") openApp(entered.key);
        else if (entered.status === "wrong")
          setCodeNote(
            `That code is not right: ${entered.triesLeft} ${entered.triesLeft === 1 ? "try" : "tries"} left.`,
          );
        else
          setCodeNote(
            <>
              That code no longer works. Make a new one in Settings → App → Devices on a paired
              device, or with <code className="font-mono whitespace-nowrap">omp-app pair</code> on
              the app's computer.
            </>,
          );
      })
      .finally(() => setBusy(false));
  };

  // A QR code's address pairs at once.
  const scanned = useRef(false);
  useEffect(() => {
    if (fromQr.current === null || scanned.current) return;
    scanned.current = true;
    submitCode();
  });

  const nameField = (
    <div className="flex flex-col gap-1.5 text-left">
      <label htmlFor={nameId} className="text-xs text-t3">
        This device's name
      </label>
      <Input
        id={nameId}
        value={name}
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        disabled={ask.kind === "asking" || ask.kind === "waiting"}
      />
    </div>
  );

  return (
    <main
      aria-label="Pair this device"
      data-omp-app="true"
      className="grid h-full place-items-center overflow-y-auto px-6 py-10"
    >
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col gap-2">
          <img src="/icon.svg" alt="" className="mb-2 size-10 rounded-lg" />
          <h1 className="text-xl font-medium text-t1">Pair this device</h1>
          {linkRefused && (
            <p className="text-sm text-t2">The link this page was opened with no longer works.</p>
          )}
          <p className="text-sm text-t2">
            This device opens the app once it is paired: allow it on a device that is already
            paired, or enter a one-time code.
          </p>
        </div>

        {mode === "ask" ? (
          ask.kind === "waiting" ? (
            <section aria-label="Waiting to be allowed" className="flex flex-col items-start gap-3">
              <p className="text-4xl font-medium tracking-wider text-t1 tabular-nums">
                {spaced(ask.asked.code)}
              </p>
              <p className="text-sm text-t2">
                On a device that is already paired, allow the request showing these digits.
              </p>
              <p role="status" className="text-xs text-t3">
                Waiting…
              </p>
              <Button variant="outline" size="sm" onClick={() => setAsk({ kind: "idle" })}>
                Cancel
              </Button>
            </section>
          ) : (
            <div className="flex flex-col gap-4">
              {nameField}
              {ask.kind === "denied" && (
                <p role="status" className="text-sm text-t2">
                  The request was turned down.
                </p>
              )}
              {ask.kind === "expired" && (
                <p role="status" className="text-sm text-t2">
                  The request ended after 5 minutes.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={startAsking}
                  disabled={ask.kind === "asking" || name.trim() === ""}
                >
                  {ask.kind === "denied" || ask.kind === "expired" ? "Ask again" : "Ask to pair"}
                </Button>
                <Button
                  variant="link"
                  className="px-0"
                  onClick={() => {
                    setProblem(null);
                    setMode("code");
                  }}
                >
                  Enter a code instead
                </Button>
              </div>
            </div>
          )
        ) : (
          <form onSubmit={submitCode} className="flex flex-col gap-4">
            {nameField}
            <div className="flex flex-col gap-1.5 text-left">
              <label htmlFor={codeId} className="text-xs text-t3">
                One-time code
              </label>
              <Input
                id={codeId}
                value={code}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder={formatPairingCode("XXXXXXXX")}
                className="font-mono tracking-wider uppercase"
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            {codeNote !== null && (
              <p role="status" className="text-sm text-t2">
                {codeNote}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={busy || normalizePairingCode(code).length !== 8 || name.trim() === ""}
              >
                Pair
              </Button>
              <Button
                type="button"
                variant="link"
                className="px-0"
                onClick={() => {
                  setProblem(null);
                  setCodeNote(null);
                  setMode("ask");
                }}
              >
                Ask a paired device instead
              </Button>
            </div>
          </form>
        )}

        {problem !== null && (
          <p role="alert" className="text-sm text-bad-ink">
            {problem}
          </p>
        )}
      </div>
    </main>
  );
}
