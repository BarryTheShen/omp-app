import { knownLogFile } from "./log-location";

/**
 * Where the app's debug log is and how to turn it into one file for a bug report. The full-page
 * screens show it, because a person who cannot get past them needs it most.
 */
export function LogHint() {
  return (
    <p className="text-muted-foreground text-sm" data-log-hint="true">
      The app keeps a log of what it does. In a terminal, <code>omp-app logs</code> prints it and{" "}
      <code>omp-app debug-report</code> saves a file to attach to a bug report. The log is here:
      <code className="mt-1 block [overflow-wrap:anywhere]">{knownLogFile()}</code>
    </p>
  );
}
