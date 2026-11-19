/**
 * `omp-app-device` (#20): one program for agent access's parts, so the machine carries one runtime, not several.
 *
 *   omp-app-device guard <settings.json>   the root-owned guard (its system service)
 *   omp-app-device wrapper                 sshd's ForceCommand for every agent session
 *   omp-app-device setup | remove          as root: make this computer ready for agent access, or undo it
 *   omp-app-device <anything else>         the person's agent and its commands (`run`, `on`, `off`, ...)
 *
 * Only the part asked for is loaded: each part's file runs as it is imported.
 */
export {};

const part = process.argv[2];
if (part === "guard" || part === "wrapper") {
  // The part reads its own arguments from argv[2] on, as when it ran alone.
  process.argv.splice(2, 1);
  await (part === "guard" ? import("./guard/main") : import("./wrapper/main"));
} else if (part === "setup" || part === "remove") {
  await import("./install/main");
} else {
  await import("./agent/main");
}
