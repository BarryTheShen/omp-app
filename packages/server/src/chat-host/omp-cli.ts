/**
 * omp's own command line, for the chat host's entry to load synchronously with `require("./omp-cli")`. omp's package
 * exports `./cli` for `import` only, so the entry requires this module, whose own import of omp's `cli.ts` is evaluated
 * in the same synchronous step. Loading it evaluates `cli.ts`, which runs itself in a compiled program and in a worker
 * thread (omp 18.12.6 `cli.ts:583-601`).
 */
export { runCli } from "@oh-my-pi/pi-coding-agent/cli";
