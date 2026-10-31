/**
 * When a host whose server has gone gives its chat back (D2, `D2-hot-reload.md` section 3): omp lets one writer at a
 * time hold a chat, so a host that outlives the server must not keep it for good, or omp's terminal (`omp-app tui`)
 * could never open it. After `waitMs` without a server (two minutes, as long as the app keeps an idle chat after its
 * last tab), a settled chat is handed back; a turn that runs is finished first, checked again every `checkMs`. A server
 * that comes back in time cancels it.
 */

/** The part of the host's socket the rule watches. */
export interface ServerLink {
  connected(): boolean;
  onConnection(listener: (connected: boolean) => void): () => void;
}

export interface Clock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: Clock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const HANDBACK_WAIT_MS = 120_000;
export const HANDBACK_CHECK_MS = 5_000;

/** Starts the rule; returns the function that stops it. */
export function startHandback(options: {
  readonly link: ServerLink;
  /** True when no turn runs and nothing waits to run. */
  readonly settled: () => boolean;
  readonly handBack: () => void;
  readonly waitMs?: number;
  readonly checkMs?: number;
  readonly clock?: Clock;
}): () => void {
  const { link, settled, handBack } = options;
  const waitMs = options.waitMs ?? HANDBACK_WAIT_MS;
  const checkMs = options.checkMs ?? HANDBACK_CHECK_MS;
  const clock = options.clock ?? SYSTEM_CLOCK;
  let timer: unknown;
  let done = false;

  const cancel = (): void => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const check = (): void => {
    timer = undefined;
    if (done || link.connected()) return;
    if (settled()) {
      done = true;
      handBack();
      return;
    }
    timer = clock.setTimeout(check, checkMs);
  };
  const stopListening = link.onConnection((connected) => {
    cancel();
    if (!connected && !done) timer = clock.setTimeout(check, waitMs);
  });
  if (!link.connected()) timer = clock.setTimeout(check, waitMs);

  return () => {
    done = true;
    cancel();
    stopListening();
  };
}
