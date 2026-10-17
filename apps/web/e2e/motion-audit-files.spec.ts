import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "@playwright/test";
import { APP_ROOT, expect } from "./real-omp";

// Row 16: the two dead assistant-ui thread files are gone (#1648).
test("row 16: the dead assistant-ui thread files are removed", () => {
  for (const file of ["thread.aui.tsx", "thread-list.aui.tsx"]) {
    expect(
      existsSync(resolve(APP_ROOT, "apps/web/src/components/assistant-ui/elements", file)),
      `${file} is removed`,
    ).toBe(false);
  }
});
