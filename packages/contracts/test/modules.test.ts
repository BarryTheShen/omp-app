import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MODULE_IDS,
  MODULES,
  NAMESPACE_OWNERSHIP,
  namespaceClaim,
  ownerOfPath,
  SETTING_SECTIONS,
} from "../src";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("module table", () => {
  test("matches PLAN.md, Modules (42)", async () => {
    const plan = await Bun.file(join(ROOT, "PLAN.md")).text();
    const table = plan.split("## Modules (42)")[1]?.split("\n## ")[0] ?? "";
    const rows = [
      ...table.matchAll(
        /^\| \[(\w\d)\]\(modules\/\1\/README\.md\) \| (.+?) \| (W\d) \| ([SML]) \| (.+?) \|$/gm,
      ),
    ].map(([, id, name, wave, size, needs]) => ({
      id,
      name,
      wave,
      size,
      needs: needs === "—" ? [] : (needs ?? "").split(", "),
    }));
    expect(rows).toHaveLength(42);
    expect(rows).toEqual(MODULES.map((module) => ({ ...module, needs: [...module.needs] })));
  });

  test("lists the ids in table order and every id has a header", async () => {
    expect([...MODULE_IDS]).toEqual(MODULES.map((module) => module.id));
    for (const id of MODULE_IDS) {
      expect(await Bun.file(join(ROOT, "modules", id, "README.md")).exists()).toBe(true);
    }
  });
});

describe("namespace ownership", () => {
  const headerSections = new Map<string, string>();
  async function sectionText(module: string, section: string): Promise<string> {
    const key = `${module}#${section}`;
    let text = headerSections.get(key);
    if (text === undefined) {
      const header = await Bun.file(join(ROOT, "modules", module, "README.md")).text();
      text = header.split(`\n## ${section}\n`)[1]?.split("\n## ")[0] ?? "";
      headerSections.set(key, text);
    }
    return text;
  }

  test("every header citation quotes its header section verbatim", async () => {
    for (const claim of NAMESPACE_OWNERSHIP) {
      expect(claim.sources.some((source) => "quote" in source)).toBe(true);
      for (const source of claim.sources) {
        if (!("quote" in source)) continue;
        const text = await sectionText(source.module, source.section);
        expect({
          claim: claim.namespace,
          source,
          found: text.includes(source.quote),
        }).toMatchObject({
          found: true,
        });
      }
    }
  });

  test("every other source is a dated main-agent decision", () => {
    const decisions = NAMESPACE_OWNERSHIP.flatMap((claim) =>
      claim.sources.filter((source) => !("quote" in source)),
    );
    expect(decisions).toHaveLength(27);
    for (const decision of decisions) {
      expect(decision).toEqual({ decision: "main agent decision", date: "2026-10-04" });
    }
  });

  test("each namespace is listed once", () => {
    const keys = NAMESPACE_OWNERSHIP.map((claim) => `${claim.kind}:${claim.namespace}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("covers every omp settings section exactly", () => {
    const sections = Object.entries(SETTING_SECTIONS).flatMap(([tab, names]) =>
      names.map((name) => `${tab}/${name}`),
    );
    expect(sections).toHaveLength(60);
    const claimed = NAMESPACE_OWNERSHIP.filter((claim) => claim.kind === "setting-section");
    expect(claimed.map((claim) => claim.namespace).sort()).toEqual(sections.sort());
  });

  test("covers the 85 builtin slash commands and the five other command sources", () => {
    const claimed = NAMESPACE_OWNERSHIP.filter((claim) => claim.kind === "slash-command").map(
      (claim) => claim.namespace,
    );
    expect(claimed.filter((namespace) => namespace.startsWith("/"))).toHaveLength(85);
    expect(claimed.filter((namespace) => namespace.startsWith("source:")).sort()).toEqual([
      "source:custom",
      "source:extension",
      "source:file",
      "source:mcp_prompt",
      "source:skill",
    ]);
  });

  test("no namespace is contested", () => {
    expect(NAMESPACE_OWNERSHIP.filter((claim) => claim.status === "contested")).toEqual([]);
  });

  test("namespaceClaim looks claims up", () => {
    expect(namespaceClaim("panel", "todo")).toMatchObject({ status: "owned", owner: "U5" });
    expect(namespaceClaim("slash-command", "/branch")).toMatchObject({
      status: "owned",
      owner: "P4",
    });
    expect(namespaceClaim("setting-section", "interaction/Stream")).toMatchObject({ owner: "I4" });
    expect(namespaceClaim("panel", "nothing")).toBeUndefined();
  });
});

describe("ownerOfPath", () => {
  const cases: Array<[string, string | undefined]> = [
    ["packages/contracts/src/ports/A1/config-store.ts", "A1"],
    ["packages/contracts/src/index.ts", "main"],
    ["packages/contracts/src/core/ids.ts", "C0"],
    ["packages/contracts/src/omp-wire/LICENSE", "C0"],
    ["packages/client/src/socket.ts", "A0"],
    ["packages/client/src/modules/P6/queue-proxy.ts", "P6"],
    ["packages/server/src/main.ts", "A0"],
    ["packages/server/src/modules/A1/config-store.ts", "A1"],
    ["packages/server/src/registry/ports.ts", "main"],
    ["packages/later-package/src/modules/T3/eval.ts", "T3"],
    ["packages/later-package/src/other.ts", undefined],
    ["apps/web/vite.config.ts", "U0"],
    ["apps/web/src/components/thread.tsx", "U0"],
    ["apps/web/src/modules/P1/roster.tsx", "P1"],
    ["apps/web/src/registry/tools.ts", "main"],
    ["modules/D5/README.md", "D5"],
    ["./PLAN.md", "main"],
    ["bun.lock", "main"],
    ["research/omp-feature-inventory.md", "main"],
  ];

  test.each(cases)("%s belongs to %s", (path, owner) => {
    expect(ownerOfPath(path)).toBe(owner as never);
  });
});
