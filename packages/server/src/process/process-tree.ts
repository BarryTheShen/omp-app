/**
 * Stops a program started with `detached: true` (its own process group) and whatever it started. Elsewhere the group is
 * signalled, also after the program itself ended, as what it started may still run. Windows has no process groups
 * (signalling one throws): there `taskkill /T /F` ends the program's tree while the program still runs, waited for, so
 * its folder is free once this returns; a program that ended has no tree left to find.
 */
export function stopProcessTree(
  child: { readonly pid: number; readonly exitCode: number | null },
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (process.platform === "win32") {
    if (child.exitCode !== null) return;
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // taskkill could not start: nothing more can stop the tree.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
}
