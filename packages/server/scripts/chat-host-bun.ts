/**
 * The Bun the chat host is compiled with: the one inside the omp release the app pins (`@oh-my-pi/pi-coding-agent` in
 * `packages/server/package.json`). `BUN_BE_BUN=1 <omp release binary> --version` prints it, because a program Bun
 * compiled runs as that Bun with this variable set. On another Bun each chat kept about 130 MB more memory (SDK plan, H0).
 * Change it with the omp package; `release.yml` and `desktop.yml` download the same version.
 */
export const CHAT_HOST_BUN_VERSION = "1.4.3";
