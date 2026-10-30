/** The styles that decide where a box's text wraps, copied onto the hidden copy that measures it. */
const COPIED = [
  "box-sizing",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-feature-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "word-break",
  "text-indent",
  "text-transform",
  "tab-size",
  "direction",
] as const;

/**
 * Whether the caret sits on the first or the last row the box draws. A long line wraps over several rows, so a newline
 * before or after the caret does not tell: the rows are measured in a hidden copy of the box, as wide as the box's text
 * (without its scrollbar) and in the same font.
 */
export function caretOnEdgeRow(box: HTMLTextAreaElement, edge: "first" | "last"): boolean {
  const style = getComputedStyle(box);
  const mirror = document.createElement("div");
  for (const property of COPIED)
    mirror.style.setProperty(property, style.getPropertyValue(property));
  const borders =
    Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
  Object.assign(mirror.style, {
    position: "absolute",
    top: "0",
    left: "0",
    visibility: "hidden",
    boxSizing: "border-box",
    width: `${box.clientWidth + borders}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  const fontSize = Number.parseFloat(style.fontSize);
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
  const topAt = (offset: number): number => {
    mirror.textContent = box.value.slice(0, offset);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.append(marker);
    return marker.offsetTop;
  };
  document.body.append(mirror);
  try {
    const caret = topAt(box.selectionStart);
    const edgeTop = topAt(edge === "first" ? 0 : box.value.length);
    return Math.abs(caret - edgeTop) < lineHeight / 2;
  } finally {
    mirror.remove();
  }
}
