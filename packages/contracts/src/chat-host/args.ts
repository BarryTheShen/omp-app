/**
 * The first argument that makes the chat host program run one chat. Every other argument list goes to omp's own command
 * line (its worker selectors, `--version`, `--smoke-test`, `models`, a bare start for its terminal UI, …).
 *
 * Kept apart from the protocol (`protocol.ts`) so the program's entry, which omp's worker threads also load, reads it
 * without loading the protocol's schemas.
 */
export const CHAT_HOST_CHAT_ARG = "__omp_app_chat";
