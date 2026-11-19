/**
 * Text a session wrote, made safe for the person's own terminals (#20): a session's command line and output are the
 * agent's to choose, and a terminal acts on escape sequences (a window title, the clipboard through OSC 52, the screen
 * cleared under a fake prompt). Built from the characters' codes, as the desktop app's Agent access panel does
 * (`apps/ui/src/panels/access/ThisComputer.tsx`).
 *
 * One pass, in which every ESC is taken by one of the alternatives: what is removed can never join its neighbours into a
 * new sequence, and the only ESC left is that of a whole colour sequence kept on purpose.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const c = (code: number) => String.fromCharCode(code);

const SEQUENCES = new RegExp(
  [
    // OSC, DCS, SOS, PM and APC strings, up to BEL or ST (ESC \), or to the end when unfinished.
    `${ESC}[\\]PX^_][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\|$)`,
    // CSI sequences; group 1 is the final byte.
    `${ESC}\\[[0-?]*[ -/]*([@-~])`,
    // Anything else that starts with ESC: a two-character escape, an unfinished CSI, a lone ESC.
    `${ESC}[ -~]?`,
  ].join("|"),
  "g",
);
/** C0 controls but tab, line feed and carriage return; DEL; the C1 controls (0x9b is CSI on some terminals). */
const CONTROLS = new RegExp(
  `[${c(0)}-${c(8)}${c(11)}-${c(12)}${c(14)}-${c(31)}${c(127)}${c(0x80)}-${c(0x9f)}]`,
  "g",
);
/** The same but ESC: after `SEQUENCES`, an ESC left is one of a colour sequence kept on purpose. */
const CONTROLS_BUT_ESC = new RegExp(
  `[${c(0)}-${c(8)}${c(11)}-${c(12)}${c(14)}-${c(26)}${c(28)}-${c(31)}${c(127)}${c(0x80)}-${c(0x9f)}]`,
  "g",
);

/** A session's terminal output for `watch`: colours (SGR, `ESC[…m`) and line breaks kept, every other control out. */
export function safeTerminalOutput(text: string): string {
  return text
    .replace(SEQUENCES, (sequence, final: string | undefined) => (final === "m" ? sequence : ""))
    .replace(CONTROLS_BUT_ESC, "");
}

/** One line of plain text (a notice to the person's terminals): no escapes, no controls, no line breaks. */
export function safeLine(text: string): string {
  return text
    .replace(SEQUENCES, "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(CONTROLS, "");
}
