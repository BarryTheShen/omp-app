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
