import { describe, expect, test } from "bun:test";
import { OMP_FLOOR_VERSION } from "@omp-app/contracts";
import serverPackage from "../../package.json";

describe("the omp the app runs", () => {
  test("is the release the contracts name as the omp floor: the omp package the server pins", () => {
    // The chat host is omp's command line from this package (#2586), so its version is the omp every chat runs.
    expect(serverPackage.dependencies["@oh-my-pi/pi-coding-agent"]).toBe(OMP_FLOOR_VERSION);
  });
});
