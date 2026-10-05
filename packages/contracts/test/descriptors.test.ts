import { describe, expect, test } from "bun:test";
import {
  type Descriptor,
  INVENTORY,
  NAMESPACE_OWNERSHIP,
  type NamespaceClaim,
  normalizeChord,
  type RegistryProblemKind,
  uncoveredInventory,
  validateRegistry,
} from "../src";

const [rowA, rowB] = INVENTORY.map((item) => item.id);
if (rowA === undefined || rowB === undefined) throw new Error("inventory is empty");

const base = { title: "Example", covers: [], requires: [] };

/** A registry with one descriptor of every kind and no problems. */
const valid: Descriptor[] = [
  {
    ...base,
    id: "T1.read",
    owner: "T1",
    kind: "tool",
    match: { by: "name", name: "read" },
    covers: [rowA],
  },
  { ...base, id: "T7.mcp", owner: "T7", kind: "tool", match: { by: "prefix", prefix: "mcp__" } },
  { ...base, id: "T7.fallback", owner: "T7", kind: "tool", match: { by: "fallback" } },
  { ...base, id: "U4.confirm", owner: "U4", kind: "dialog", requires: ["omp.ui"] },
  { ...base, id: "U5.todo", owner: "U5", kind: "panel", covers: [rowB] },
  {
    ...base,
    id: "P7.compact",
    owner: "P7",
    kind: "command",
    slash: { name: "compact", source: "builtin" },
  },
  {
    ...base,
    id: "D2.skills",
    owner: "D2",
    kind: "command",
    slash: { name: "skill:review", source: "skill" },
  },
  { ...base, id: "U0.about", owner: "U0", kind: "command" },
  {
    ...base,
    id: "P7.compactionEnabled",
    owner: "P7",
    kind: "setting",
    key: "compaction.enabled",
    section: "context/Compaction",
  },
  { ...base, id: "D1.modelRoles", owner: "D1", kind: "setting", key: "modelRoles", section: null },
  { ...base, id: "U0.palette", owner: "U0", kind: "shortcut", chord: "Mod+K", scope: "global" },
  { ...base, id: "U2.link", owner: "U2", kind: "shortcut", chord: "Mod+K", scope: "composer" },
  { ...base, id: "N1.git", owner: "N1", kind: "status" },
  { ...base, id: "N1.retry", owner: "N1", kind: "notice", severity: "warning" },
];

function kindsWith(...extra: unknown[]): RegistryProblemKind[] {
  return validateRegistry([...valid, ...extra]).map((problem) => problem.kind);
}

describe("validateRegistry", () => {
  test("accepts a registry without conflicts", () => {
    expect(validateRegistry(valid)).toEqual([]);
  });

  test("rejects a descriptor that breaks its schema", () => {
    expect(kindsWith({ id: "T1.broken", kind: "tool" })).toEqual(["invalid"]);
    expect(
      kindsWith({
        ...base,
        id: "T1.x",
        owner: "T1",
        kind: "setting",
        key: "a",
        section: "tools/Nope",
      }),
    ).toEqual(["invalid"]);
    expect(kindsWith({ ...base, id: "Q1.x", owner: "T1", kind: "status" })).toEqual(["invalid"]);
  });

  test("rejects an id whose prefix is not the owner", () => {
    expect(kindsWith({ ...base, id: "T1.other", owner: "T2", kind: "status" })).toEqual([
      "owner-mismatch",
    ]);
  });

  test("rejects a duplicate id", () => {
    expect(kindsWith({ ...base, id: "N1.git", owner: "N1", kind: "status" })).toEqual([
      "duplicate-id",
    ]);
  });

  test("rejects unknown and doubly covered inventory rows", () => {
    expect(
      kindsWith({ ...base, id: "N1.x", owner: "N1", kind: "status", covers: ["Z9.nope"] }),
    ).toEqual(["unknown-inventory-id"]);
    expect(kindsWith({ ...base, id: "N1.x", owner: "N1", kind: "status", covers: [rowA] })).toEqual(
      ["inventory-double-claim"],
    );
  });

  test("rejects a second owner of an omp tool name, prefix, or the fallback", () => {
    expect(
      kindsWith({
        ...base,
        id: "T3.read",
        owner: "T3",
        kind: "tool",
        match: { by: "name", name: "read" },
      }),
    ).toEqual(["double-claim"]);
    expect(
      kindsWith({
        ...base,
        id: "I1.mcp",
        owner: "I1",
        kind: "tool",
        match: { by: "prefix", prefix: "mcp__" },
      }),
    ).toEqual(["double-claim"]);
    expect(
      kindsWith({
        ...base,
        id: "U3.fallback",
        owner: "U3",
        kind: "tool",
        match: { by: "fallback" },
      }),
    ).toEqual(["double-claim"]);
  });

  test("rejects a second owner of a slash command", () => {
    const again = {
      ...base,
      id: "P7.compactAgain",
      owner: "P7",
      kind: "command",
      slash: { name: "compact", source: "builtin" },
    };
    expect(kindsWith(again)).toEqual(["double-claim"]);
    const skill = {
      ...base,
      id: "D2.review",
      owner: "D2",
      kind: "command",
      slash: { name: "skill:review", source: "skill" },
    };
    expect(kindsWith(skill)).toEqual(["double-claim"]);
  });

  test("rejects a second owner of a setting key", () => {
    const again = {
      ...base,
      id: "D1.modelRolesAgain",
      owner: "D1",
      kind: "setting",
      key: "modelRoles",
      section: null,
    };
    expect(kindsWith(again)).toEqual(["double-claim"]);
  });

  test("rejects the same chord twice in one scope, in any spelling", () => {
    const again = {
      ...base,
      id: "U2.palette",
      owner: "U2",
      kind: "shortcut",
      chord: "k+mod",
      scope: "global",
    };
    expect(kindsWith(again)).toEqual(["double-claim"]);
    const otherScope = {
      ...base,
      id: "P1.palette",
      owner: "P1",
      kind: "shortcut",
      chord: "Mod+K",
      scope: "agents",
    };
    expect(kindsWith(otherScope)).toEqual([]);
  });

  test("rejects a namespace the ownership table gives to another module", () => {
    expect(kindsWith({ ...base, id: "D6.todo", owner: "D6", kind: "panel" })).toEqual([
      "not-owner",
    ]);
    const command = {
      ...base,
      id: "D5.compact",
      owner: "D5",
      kind: "command",
      slash: { name: "compact", source: "builtin" },
    };
    expect(kindsWith(command)).toEqual(["double-claim", "not-owner"]);
    const setting = {
      ...base,
      id: "S1.lsp",
      owner: "S1",
      kind: "setting",
      key: "lsp.enabled",
      section: "files/LSP",
    };
    expect(kindsWith(setting)).toEqual(["not-owner"]);
  });

  test("gives decided namespaces to their decided owner only", () => {
    const switchCommand = {
      ...base,
      kind: "command",
      slash: { name: "switch", source: "builtin" },
    };
    expect(kindsWith({ ...switchCommand, id: "D1.switch", owner: "D1" })).toEqual([]);
    expect(kindsWith({ ...switchCommand, id: "D3.switch", owner: "D3" })).toEqual(["not-owner"]);
    const voice = { ...base, kind: "setting", key: "live.voice", section: "providers/Services" };
    expect(kindsWith({ ...voice, id: "I5.voice", owner: "I5" })).toEqual([]);
    expect(kindsWith({ ...voice, id: "D3.voice", owner: "D3" })).toEqual(["not-owner"]);
  });

  test("rejects any registration in a contested namespace", () => {
    const ownership: NamespaceClaim[] = [
      ...NAMESPACE_OWNERSHIP,
      {
        kind: "panel",
        namespace: "lab",
        status: "contested",
        candidates: ["U5", "P1"],
        sources: [],
        note: "a contest for this test",
      },
    ];
    const lab = { ...base, id: "P1.lab", owner: "P1", kind: "panel" };
    const problems = validateRegistry([...valid, lab], ownership);
    expect(problems.map((problem) => problem.kind)).toEqual(["contested-namespace"]);
    expect(validateRegistry(valid, ownership)).toEqual([]);
  });
});

describe("helpers", () => {
  test("normalizeChord ignores case and modifier order", () => {
    expect(normalizeChord(" Shift+Mod+K ")).toBe("mod+shift+k");
    expect(normalizeChord("G  G")).toBe("g g");
  });

  test("uncoveredInventory lists rows no descriptor covers", () => {
    const uncovered = uncoveredInventory(valid);
    expect(uncovered).toHaveLength(INVENTORY.length - 2);
    expect(uncovered).not.toContain(rowA);
  });
});
