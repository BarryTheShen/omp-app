/**
 * App-facing names for omp: the release the app runs, and omp's own objects (`Omp`, typed from omp's SDK).
 */
import type * as OmpTypes from "../chat-host/omp-types";

/** omp's own objects, typed from omp's SDK (`../chat-host/omp-types.ts`). */
export type * as Omp from "../chat-host/omp-types";

/**
 * The omp release the app runs and supports: the `@oh-my-pi/pi-coding-agent` version `packages/server/package.json` pins,
 * whose command line the app builds into its chat host and runs, and no other. The contracts package cannot read that file,
 * so `packages/server/src/omp-host/omp-version.test.ts` keeps the two equal.
 */
export const OMP_FLOOR_VERSION = "18.18.5";

/** One of omp's session events (`Omp.SessionEvent`). */
export type OmpEvent = OmpTypes.SessionEvent;

/** A transcript message, discriminated by `role` (`Omp.AgentMessage`). Messages carry no session entry id; see ids.ts. */
export type OmpMessage = OmpTypes.AgentMessage;
