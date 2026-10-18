import { type Descriptor, INVENTORY, namespaceClaim, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createRegistry } from "@/registry-core";
import { P3_SHORTCUT_DESCRIPTORS } from "../../P3/shortcuts/descriptors";
import {
  D5_DESCRIPTORS,
  D5_LIFECYCLE_COMMAND_DESCRIPTORS,
  D5_NAMESPACE_COMMAND_DESCRIPTORS,
} from ".";

const sorted = (values: readonly string[]): string[] => [...values].sort();
const D5_OWNED_ROWS = INVENTORY.filter(
  (item) =>
    item.group === "C2" ||
    (item.group === "C1" && (item.id.includes("session") || item.id.includes("ssh"))),
).filter((item) => item.id !== "C2.app-retry");

const D5_SLASH_NAMES = [
  "/session",
  "/new",
  "/fresh",
  "/clear",
  "/handoff",
  "/ssh",
  "/retry",
  "/move",
  "/add-dir",
  "/remove-dir",
  "/dirs",
  "/delete",
  "/pin",
  "/rename",
  "/wt",
  "/restart",
] as const;

describe("D5.5 descriptor inventory and composition handoff", () => {
  test("claims all 25 D5-owned C1/C2 rows exactly once", () => {
    const covered = D5_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(D5_OWNED_ROWS).toHaveLength(25);
    expect(sorted(covered)).toEqual(sorted(D5_OWNED_ROWS.map((item) => item.id)));
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered).not.toContain("C2.app-retry");
  });
  test("requires exact capabilities for terminal-only and gateway-owned commands", () => {
    const byId = new Map<string, Descriptor>(
      D5_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
    );
    expect(byId.get("D5.worktree")?.requires).toEqual(["upstream.worktree"]);
    for (const id of ["D5.ssh", "D5.sshAdd", "D5.sshHelp", "D5.sshList", "D5.sshRemove"]) {
      expect(byId.get(id)?.requires).toEqual(["host.command-gateway"]);
    }
    expect(byId.get("D5.handoff")?.requires).toEqual(["omp.cmd.handoff"]);
    expect(byId.get("D5.handoffSummaryDivider")?.requires).toEqual(["omp.cmd.handoff"]);
    expect(byId.get("D5.retry")?.requires).toEqual(["host.command-gateway"]);
    expect(byId.get("D5.delete")?.requires).toEqual(["host.command-gateway"]);
    expect(byId.get("D5.pin")?.requires).toEqual(["host.session-pins"]);
    expect(byId.get("D5.rename")?.requires).toEqual(["omp.cmd.set_session_name"]);
    expect(byId.get("D5.new")?.requires).toEqual(["omp.cmd.new_session"]);
    expect(byId.get("D5.clear")?.requires).toEqual(["upstream.session-clear"]);
  });

  test("composes with P3 and has one owner for the Alt+R retry row", () => {
    const composed = createRegistry([...D5_DESCRIPTORS, ...P3_SHORTCUT_DESCRIPTORS]);
    expect(
      composed.descriptors.filter((descriptor) =>
        (descriptor.covers as readonly string[]).includes("C2.app-retry"),
      ),
    ).toHaveLength(1);
    expect(
      composed.descriptors.find((descriptor) =>
        (descriptor.covers as readonly string[]).includes("C2.app-retry"),
      )?.owner,
    ).toBe("P3");
  });

  test("passes C0 validation and preserves the earlier lifecycle descriptors", () => {
    expect(validateRegistry(D5_DESCRIPTORS)).toEqual([]);
    expect(D5_LIFECYCLE_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      "D5.new",
      "D5.fresh",
      "D5.clear",
    ]);
  });

  test("exports every D5-owned builtin slash namespace once", () => {
    const slashNames = D5_DESCRIPTORS.flatMap((descriptor) =>
      descriptor.kind === "command" && descriptor.slash?.source === "builtin"
        ? [`/${descriptor.slash.name}`]
        : [],
    );
    expect(sorted(slashNames)).toEqual(sorted(D5_SLASH_NAMES));
    expect(new Set(slashNames).size).toBe(slashNames.length);
    for (const name of slashNames) {
      const claim = namespaceClaim("slash-command", name);
      expect(claim?.status).toBe("owned");
      if (claim?.status === "owned") expect(claim.owner).toBe("D5");
    }
    expect(D5_NAMESPACE_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.covers)).toEqual([
      [],
      [],
    ]);
  });
});
