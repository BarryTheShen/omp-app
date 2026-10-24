#!/usr/bin/env bun
/**
 * Puts the omp the app pins (`src/omp-pin/pin.json`) in a folder and prints its path: the folder given, else
 * `OMP_APP_OMP_DIR`, else this checkout's `.data/omp`, where the live e2e tests look for it. Downloads only when the
 * file is not there yet, and checks the download against the release's SHA-256. Other releases in the folder are kept:
 * it is a folder that checkouts of other versions share.
 *
 *   bun packages/server/scripts/fetch-omp.ts [folder]
 */
import { resolve } from "node:path";
import { ensurePinnedOmp } from "../src/omp-pin";

const dir = resolve(
  process.argv[2] ?? Bun.env.OMP_APP_OMP_DIR ?? resolve(import.meta.dir, "../../../.data/omp"),
);
console.log(await ensurePinnedOmp({ dir, removeOlder: false }));
