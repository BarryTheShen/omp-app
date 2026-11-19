import { expect, test } from "bun:test";
import { safeLine, safeTerminalOutput } from "./safe-text";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test("a session's output reaches the person's terminal with its colours, never a title, the clipboard or a cleared screen (#20)", () => {
  const coloured = `${ESC}[31mred${ESC}[0m\r\nnext\n`;
  expect(safeTerminalOutput(coloured)).toBe(coloured);
  expect(safeTerminalOutput(`${ESC}]52;c;ZXZpbA==${BEL}after`)).toBe("after");
  expect(safeTerminalOutput(`${ESC}]0;fake title${ESC}\\after`)).toBe("after");
  expect(safeTerminalOutput(`${ESC}[2J${ESC}[Hfake prompt$ `)).toBe("fake prompt$ ");
  expect(safeTerminalOutput(`a${String.fromCharCode(0x9b)}2Jb`)).toBe("a2Jb");
});

test("what is removed never joins its neighbours into a new sequence", () => {
  // Removing the inner `ESC[2J` would leave `ESC[` + `2J`: a clear-screen, had the outer one been kept.
  const out = safeTerminalOutput(`${ESC}[${ESC}[2J2J`);
  expect(out.includes(ESC)).toBe(false);
  expect(safeTerminalOutput(`${ESC}${ESC}]52;c;x${BEL}`).includes(ESC)).toBe(false);
});

test("a notice is one plain line", () => {
  expect(safeLine(`ls${ESC}[2J\r\n${ESC}]52;c;x${BEL}rm -rf ~`)).toBe("ls rm -rf ~");
});
