import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { D4_FORK_DESCRIPTORS, SHARE_IMPORT_UNAVAILABLE_REASON } from "./descriptors";

describe("the import palette command", () => {
  test("passes the registry check with no problems", () => {
    expect(validateRegistry(D4_FORK_DESCRIPTORS)).toEqual([]);
  });

  test("is app-only: it claims no inventory row and no omp slash name", () => {
    expect(D4_FORK_DESCRIPTORS).toMatchObject([
      { id: "D4.importShare", owner: "D4", kind: "command", covers: [] },
    ]);
    expect(D4_FORK_DESCRIPTORS[0]).not.toHaveProperty("slash");
  });

  test("needs the session-import host capability and the upstream gate, so the palette shows why it is unavailable", () => {
    expect(D4_FORK_DESCRIPTORS).toMatchObject([
      { requires: ["host.session-import", "upstream.session-import"] },
    ]);
  });

  test("its unavailable reason is one plain sentence, with omp in lowercase", () => {
    expect(SHARE_IMPORT_UNAVAILABLE_REASON).toBe(
      "omp can't import shared chats in this version. Importing needs a newer version of omp.",
    );
  });
});
