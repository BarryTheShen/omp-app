import { describeHostContext, HostContext, hostContextPlace } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { contextFor, linesOf, type Selected } from "./context";

const select = (
  startLine: number,
  endLine: number,
  endCharacter: number,
  text: string,
): Selected => ({
  start: { line: startLine, character: 0 },
  end: { line: endLine, character: endCharacter },
  text,
});

describe("what goes with each message from the panel", () => {
  test("a text file: its path, and the selected lines and text", () => {
    expect(contextFor({ kind: "text", path: "src/app.ts" })).toEqual({
      kind: "file",
      title: "src/app.ts",
      uri: "src/app.ts",
    });
    const context = contextFor({
      kind: "text",
      path: "src/app.ts",
      selected: select(2, 6, 4, "const a = 1;"),
    });
    expect(context).toEqual({
      kind: "file",
      title: "src/app.ts",
      uri: "src/app.ts#L3-7",
      selection: "const a = 1;",
    });
  });

  test("a notebook: the cell, counted from 1, and its selected lines; its text when nothing is selected", () => {
    const path = "chapter0/0.3_Optimization_exercises.ipynb";
    expect(
      contextFor({ kind: "notebook", path, cell: { index: 3, text: "import torch\nx = 1\n" } }),
    ).toEqual({
      kind: "notebook",
      title: `${path}, cell 4`,
      uri: `${path}#cell4`,
      text: "import torch\nx = 1\n",
    });
    expect(
      contextFor({
        kind: "notebook",
        path,
        cell: {
          index: 3,
          text: "import torch\nx = 1\n",
          selected: select(0, 1, 5, "import torch\nx = 1"),
        },
      }),
    ).toEqual({
      kind: "notebook",
      title: `${path}, cell 4`,
      uri: `${path}#cell4-L1-2`,
      selection: "import torch\nx = 1",
    });
    // An empty cell gives no text; a notebook with no cell chosen gives its path.
    expect(contextFor({ kind: "notebook", path, cell: { index: 0, text: "  \n" } })).toEqual({
      kind: "notebook",
      title: `${path}, cell 1`,
      uri: `${path}#cell1`,
    });
    expect(contextFor({ kind: "notebook", path })).toEqual({
      kind: "notebook",
      title: path,
      uri: path,
    });
  });

  test("another tab: its file, or else its label; nothing open, nothing goes", () => {
    expect(contextFor({ kind: "tab", label: "logo.png", path: "assets/logo.png" })).toEqual({
      kind: "file",
      title: "assets/logo.png",
      uri: "assets/logo.png",
    });
    expect(contextFor({ kind: "tab", label: "Preview README.md" })).toEqual({
      kind: "view",
      title: "Preview README.md",
    });
    expect(contextFor({ kind: "tab", label: "  " })).toBeNull();
    expect(contextFor(null)).toBeNull();
  });

  test("a selection that ends at the start of a line leaves that line out", () => {
    expect(linesOf(select(2, 5, 0, "three lines\n"))).toEqual([3, 5]);
    expect(linesOf(select(2, 5, 1, "x"))).toEqual([3, 6]);
    expect(linesOf(select(4, 4, 0, ""))).toEqual([5, 5]);
  });

  test("a long selection or cell is cut to what the protocol takes, and omp app reads the place back as written", () => {
    const long = "x".repeat(9_000);
    const cut = contextFor({ kind: "text", path: "a.ts", selected: select(0, 0, 3, long) });
    expect(cut?.selection?.length).toBe(8_000);
    const views = [
      contextFor({ kind: "text", path: "src/app.ts", selected: select(9, 9, 2, "ab") }),
      contextFor({ kind: "notebook", path: "nb/x.ipynb", cell: { index: 1, text: "y = 2" } }),
      contextFor({
        kind: "notebook",
        path: "nb/x.ipynb",
        cell: { index: 1, text: "y = 2\nz = 3", selected: select(0, 1, 5, "y = 2\nz = 3") },
      }),
      cut,
    ];
    const said = views.map((context) => {
      if (context === null) throw new Error("no context");
      expect(HostContext.safeParse(context).success).toBe(true);
      return describeHostContext(context);
    });
    expect(said).toEqual([
      "Line 10 of app.ts",
      "Cell 2 of x.ipynb",
      "Lines 1–2 of cell 2, x.ipynb",
      "Line 1 of a.ts",
    ]);
    expect(hostContextPlace(views[2]?.uri ?? "")).toEqual({
      path: "nb/x.ipynb",
      cell: 2,
      lines: [1, 2],
    });
  });
});
