/**
 * Builds agent access (#20) as one program, `dist/omp-app-device`, whose parts are its subcommands (`guard`,
 * `wrapper`, and the person's agent): one runtime on the machine instead of three. An install puts it in
 * `/usr/lib/omp-app-device/`, with the units and the polkit action in `system/`.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const built = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    // The program runs as root (the guard) and from any folder (the person's commands, maybe in one the agent account
    // can write): it must never load a `.env` or `bunfig.toml` found there, which compiled programs do by default.
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--minify",
    join(root, "src", "main.ts"),
    "--outfile",
    join(root, "dist", "omp-app-device"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(built.exitCode ?? 1);
