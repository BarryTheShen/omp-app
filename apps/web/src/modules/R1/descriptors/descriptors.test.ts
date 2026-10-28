import { type CapabilityMap, normalizeChord, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { isDescriptorAvailable } from "@/registry-core/hooks";
import { ShortcutRegistry } from "@/shortcuts/registry";
import { R1_DESCRIPTORS, R1_SESSION_LIST_SCOPE } from ".";

const EXPECTED_COVERS = [
  "F3.open-session",
  "D2.resume",
  "D2.session-delete-confirmation",
  "D2.session-pin-account-selector",
  "D2.session-selector",
  "D2.app-session-delete",
  "D2.app-session-deletenoninvasive",
  "D2.app-session-rename",
] as const;

describe("R1 descriptor coverage", () => {
  test("declares the command, dialog and session-list rows; the rest are native or not offered", () => {
    expect(R1_DESCRIPTORS).toHaveLength(8);
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

  test("Open session needs the saved session files", () => {
    const openSession = R1_DESCRIPTORS.find((descriptor) => descriptor.id === "R1.openSession");
    if (!openSession) throw new Error("R1.openSession is missing");
    const chatHost: CapabilityMap = {
      "host.session-files": { state: "available", via: "host" },
    };
    expect(isDescriptorAvailable(openSession, chatHost)).toBe(true);
    expect(
      isDescriptorAvailable(openSession, {
        ...chatHost,
        "host.session-files": { state: "unavailable", via: "host", detail: "no session files" },
      }),
    ).toBe(false);
  });

  test("declares only the three session-list chords, each on the list's own scope and focus", () => {
    const chords = R1_DESCRIPTORS.flatMap((descriptor) =>
      descriptor.kind === "shortcut" ? [descriptor] : [],
    );
    expect(chords.map((descriptor) => [descriptor.id, descriptor.chord])).toEqual([
      ["R1.sessionDelete", "Mod+Shift+Backspace"],
      ["R1.sessionDeleteNoninvasive", "Mod+Backspace"],
      ["R1.sessionRename", "F2"],
    ]);
    for (const descriptor of chords) {
      expect(descriptor.scope).toBe(R1_SESSION_LIST_SCOPE);
      expect(descriptor).toHaveProperty("focus", R1_SESSION_LIST_SCOPE);
    }
  });

  test("none of the chords is browser-reserved, and no chord collides with another in its scope", () => {
    const registry = new ShortcutRegistry(R1_DESCRIPTORS);
    expect(registry.problems()).toEqual([]);
    expect(registry.conflicts()).toEqual([]);
    for (const descriptor of R1_DESCRIPTORS) {
      if (descriptor.kind !== "shortcut") continue;
      expect(registry.isBrowserReserved(descriptor.chord, descriptor.scope)).toBe(false);
      expect(normalizeChord(descriptor.chord)).not.toBe("");
    }
  });
});
