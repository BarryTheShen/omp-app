import { describe, expect, test } from "vitest";
import { SETTINGS_SECTIONS } from "@/registry";
import { sectionMatchesSearch } from "./settings-screen";

describe("settings section names", () => {
  test("no section name repeats its tab, so the list row and the heading read as plain labels", () => {
    for (const descriptor of SETTINGS_SECTIONS) {
      expect(descriptor.title, descriptor.id).not.toContain(" / ");
    }
  });

  test("a section name is unique within its tab", () => {
    const namesByTab = new Map<string, Set<string>>();
    for (const descriptor of SETTINGS_SECTIONS) {
      const [tab = ""] = descriptor.section.split("/");
      const names = namesByTab.get(tab) ?? new Set<string>();
      expect(names.has(descriptor.title), `${tab}: ${descriptor.title}`).toBe(false);
      names.add(descriptor.title);
      namesByTab.set(tab, names);
    }
  });

  test("a search for omp's own spelling with & still finds a section whose name says and", () => {
    const titlesFor = (query: string) =>
      SETTINGS_SECTIONS.filter((descriptor) => sectionMatchesSearch(descriptor, query)).map(
        (descriptor) => descriptor.title,
      );
    expect(titlesFor("grep & browser")).toContain("Grep and Browser");
    expect(titlesFor("eval & runtimes")).toContain("Eval and Runtimes");
    expect(titlesFor("commands & skills")).toContain("Commands and Skills");
    expect(titlesFor("discovery & mcp")).toContain("Discovery and MCP");
    expect(titlesFor("grep and browser")).toContain("Grep and Browser");
  });
});
