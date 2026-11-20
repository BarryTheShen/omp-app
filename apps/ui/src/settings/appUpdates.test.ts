import type { AppUpdates } from "@omp-app/contracts";
import { expect, test } from "vitest";
import { serverUpdate } from "./appUpdates";

const updates = (installed: string, latest: string | null): AppUpdates => ({
  installed,
  latest: latest === null ? null : { version: latest, at: "2026-11-20T20:00:00Z" },
  checkedAt: "2026-11-20T21:00:00Z",
  install: { possible: true },
  job: null,
  last: null,
});

test("a newer release is offered by number, never to a development build, and not before a look succeeded", () => {
  expect(serverUpdate(updates("0.3.1684", "0.3.1700"))).toBe("0.3.1700");
  // By number, not by text: 0.3.999 is older than 0.3.1684.
  expect(serverUpdate(updates("0.3.1684", "0.3.999"))).toBeNull();
  expect(serverUpdate(updates("0.3.1684", "0.3.1684"))).toBeNull();
  expect(serverUpdate(updates("0.3.1684", "0.4.0"))).toBe("0.4.0");
  expect(serverUpdate(updates("0.0.0", "0.3.1700"))).toBeNull();
  expect(serverUpdate(updates("dev", "0.3.1700"))).toBeNull();
  expect(serverUpdate(updates("0.3.1684", null))).toBeNull();
  expect(serverUpdate(null)).toBeNull();
});
