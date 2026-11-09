/**
 * The first argument that makes the chat host program run one chat. Every other argument list goes to omp's own command
 * line (its worker selectors, `--version`, `--smoke-test`, `models`, a bare start for its terminal UI, …).
 *
 * Kept apart from the protocol (`protocol.ts`) so the program's entry, which omp's worker threads also load, reads it
 * without loading the protocol's schemas.
 */
export const CHAT_HOST_CHAT_ARG = "__omp_app_chat";

/**
 * Right after `CHAT_HOST_CHAT_ARG`, `--app-host-socket=<path>`: the Unix socket a host that outlives its server listens
 * on (D2). It is an argument, not an environment variable, so nothing the chat runs inherits it: a host started there
 * with this host's socket would delete it and take its place.
 */
export const CHAT_HOST_SOCKET_ARG = "--app-host-socket";

/**
 * `--app-host-files=<host>`: the chat's files are on the computer of the app that shows it in a panel (`<host>`, such as
 * `vscode`), not on this one. The server gives it to a chat whose folder is one of the app's host folders; the chat host
 * then leaves out omp's own tools that work on this computer's files and shell, and tells the model where the files are.
 */
export const CHAT_HOST_FILES_ARG = "--app-host-files";
