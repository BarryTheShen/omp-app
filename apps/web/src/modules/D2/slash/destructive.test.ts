import { describe, expect, test } from "vitest";
import { DESTRUCTIVE_FORMS, destructiveQuestion } from "./destructive";

describe("the questions before the typed forms that delete data", () => {
  test("every form that deletes data has a question, and no other form does", () => {
    expect([...DESTRUCTIVE_FORMS].sort()).toEqual([
      "marketplace remove",
      "marketplace rm",
      "marketplace uninstall",
      "mcp remove",
      "mcp rm",
      "memory clear",
      "memory reset",
      "modelpreset delete",
      "ssh remove",
      "ssh rm",
    ]);
  });

  test("a named SSH host or MCP server is named as typed, and its config is the project's unless --scope says user", () => {
    expect(destructiveQuestion("ssh rm", "dev")).toEqual({
      label: "Remove SSH host",
      title: 'Remove the SSH host "dev" from the project config?',
      description: "Its entry is deleted from that config file. This cannot be undone.",
      confirmLabel: "Remove host",
    });
    expect(destructiveQuestion("mcp remove", "github --scope user")?.title).toBe(
      'Remove the MCP server "github" from the user config?',
    );
    expect(destructiveQuestion("ssh remove", '"build" --scope project')?.title).toBe(
      'Remove the SSH host "build" from the project config?',
    );
  });

  test("a marketplace, a plugin and a preset are named as typed, and uninstall names the scope when one is typed", () => {
    expect(destructiveQuestion("marketplace rm", "market")?.title).toBe(
      'Remove the marketplace "market"?',
    );
    expect(destructiveQuestion("marketplace uninstall", "plugin@market")?.title).toBe(
      'Uninstall "plugin@market"?',
    );
    expect(destructiveQuestion("marketplace uninstall", "--scope user plugin@market")?.title).toBe(
      'Uninstall "plugin@market" from the user scope?',
    );
    expect(destructiveQuestion("modelpreset delete", "fast")?.title).toBe(
      'Delete the model preset "fast"?',
    );
  });

  test("memory clear and memory reset both ask about all saved memory, whatever follows them", () => {
    expect(destructiveQuestion("memory clear", "")?.title).toBe("Clear all saved memory?");
    expect(destructiveQuestion("memory reset", "now")?.title).toBe("Clear all saved memory?");
  });

  test("a scope omp refuses, and a form that names nothing, have no question, so nothing is asked about a delete omp will not make", () => {
    expect(destructiveQuestion("ssh remove", "dev --scope global")).toBeNull();
    expect(destructiveQuestion("ssh remove", "--scope user")).toBeNull();
    expect(destructiveQuestion("marketplace uninstall", "--scope user")).toBeNull();
    expect(destructiveQuestion("marketplace remove", "")).toBeNull();
    expect(destructiveQuestion("modelpreset delete", "")).toBeNull();
  });

  test("a form that does not delete data, or a name that only resembles one, has no question", () => {
    expect(destructiveQuestion("memory view", "")).toBeNull();
    expect(destructiveQuestion("ssh list", "")).toBeNull();
    expect(destructiveQuestion("constructor", "x")).toBeNull();
  });
});
