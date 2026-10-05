import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTORS, R1_DESCRIPTORS } from ".";

const EXPECTED_COVERS = [
  "F3.open-session",
  "D2.resume",
  "D2.session-delete-confirmation",
  "D2.session-pin-account-selector",
  "D2.session-selector",
  "D2.app-session-delete",
  "D2.app-session-deletenoninvasive",
  "D2.app-session-fork",
  "D2.app-session-new",
  "D2.app-session-observe",
  "D2.app-session-rename",
  "D2.app-session-resume",
  "D2.app-session-togglepath",
  "D2.app-session-togglesort",
] as const;

describe("R1 descriptor coverage", () => {
  test("covers exactly F3.open-session and the thirteen D2 rows", () => {
    expect(DESCRIPTORS).toBe(R1_DESCRIPTORS);
    expect(R1_DESCRIPTORS).toHaveLength(14);
    const covers = R1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers).sort();
    expect(covers).toEqual([...EXPECTED_COVERS].sort());
    expect(new Set(covers).size).toBe(covers.length);
  });

  test("passes C0 descriptor validation without claiming another module's namespace", () => {
    expect(validateRegistry(R1_DESCRIPTORS)).toEqual([]);
  });

  test("gates server-owned catalog and mutation capabilities explicitly", () => {
    const byId = new Map(R1_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
    expect(byId.get("R1.sessionSelector")?.requires).toContain("host.session-files");
    expect(byId.get("R1.sessionDelete")?.requires).toEqual([
      "host.session-files",
      "host.command-gateway",
    ]);
    expect(byId.get("R1.sessionPinAccountSelector")?.requires).toEqual(["host.session-pins"]);
    expect(byId.get("R1.sessionRename")?.requires).toEqual(["omp.cmd.set_session_name"]);
  });
});
