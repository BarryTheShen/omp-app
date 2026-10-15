import { P4_DESCRIPTORS } from "../contract";

/**
 * P4's owner-prefixed descriptors: the nine durable-tree rows that P4.1 defines in `contract/descriptors.ts`.
 * `descriptors.test.ts` proves they cover the owned inventory rows exactly, each once. The central registry
 * imports `P4_DESCRIPTORS` from `../modules/P4/contract` (registry/index.ts:23), not from this barrel.
 */
export { P4_DESCRIPTORS };
