/**
 * Access turns off when the screen locks or the computer is about to sleep (#20): the person is away, so nothing should
 * keep working on the computer in their name. Read from logind on the system bus with `gdbus monitor`, which prints each
 * signal as `<path>: <interface>.<member> <arguments>` (GLib's gdbus-tool.c, `monitor_signal_cb`). Any session's lock
 * counts: turning off is always safe. Without `gdbus` (a server without GLib's tools), access only ends by its deadline
 * or by an off.
 */

export type LockEvent = "locked" | "sleeping";

/** What one line of `gdbus monitor --system --dest org.freedesktop.login1` means for access, if anything. */
export function lockEventOf(line: string): LockEvent | null {
  if (/: org\.freedesktop\.login1\.Manager\.PrepareForSleep \(true,\)$/.test(line))
    return "sleeping";
  if (/: org\.freedesktop\.login1\.Session\.Lock \(\)$/.test(line)) return "locked";
  // GNOME's lock screen sets the session's LockedHint.
  if (
    /: org\.freedesktop\.DBus\.Properties\.PropertiesChanged \('org\.freedesktop\.login1\.Session', \{[^}]*'LockedHint': <true>/.test(
      line,
    )
  )
    return "locked";
  return null;
}

/** The monitor command: line-buffered through `stdbuf`, as gdbus never flushes its output into a pipe. */
function monitorCommand(): string[] | null {
  const gdbus = Bun.which("gdbus");
  if (gdbus === null) return null;
  const stdbuf = Bun.which("stdbuf");
  return [
    ...(stdbuf === null ? [] : [stdbuf, "-oL"]),
    gdbus,
    "monitor",
    "--system",
    "--dest",
    "org.freedesktop.login1",
  ];
}

/**
 * Calls `onEvent` for each lock or sleep until stopped; restarts the monitor if it ends. `command` replaces the
 * monitor (tests).
 */
export function watchLock(
  onEvent: (event: LockEvent) => void,
  log: (line: string) => void,
  command: readonly string[] | null = monitorCommand(),
): () => void {
  if (command === null) {
    log("gdbus is not installed: access does not turn off on screen lock or sleep here");
    return () => undefined;
  }
  let stopped = false;
  let child: Bun.Subprocess<"ignore", "pipe", "ignore"> | null = null;
  const start = (): void => {
    const running = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    child = running;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of running.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let end = buffer.indexOf("\n");
        while (end !== -1) {
          const event = lockEventOf(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (event !== null) onEvent(event);
          end = buffer.indexOf("\n");
        }
      }
      await running.exited;
      if (!stopped) setTimeout(start, 5_000);
    })();
  };
  start();
  return () => {
    stopped = true;
    child?.kill();
  };
}
