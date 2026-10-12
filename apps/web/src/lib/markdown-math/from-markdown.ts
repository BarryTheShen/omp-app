import type { Literal } from "mdast";
import type { CompileContext, Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Token } from "micromark-util-types";

/** A formula in running text. `value` is what sits between its delimiters, as written. */
interface InlineMath extends Literal {
  type: "inlineMath";
}

declare module "mdast" {
  interface PhrasingContentMap {
    inlineMath: InlineMath;
  }
  interface RootContentMap {
    inlineMath: InlineMath;
  }
}

/** The mdast extension: a formula becomes an `inlineMath` node that renders as a `span` with its source attached. */
export function mathFromMarkdown(): FromMarkdownExtension {
  return {
    enter: { mathInline: enterMathInline },
    exit: { mathInline: exitMathInline },
  };
}

function enterMathInline(this: CompileContext, token: Token): void {
  this.enter({ type: "inlineMath", value: "" }, token);
}

function exitMathInline(this: CompileContext, token: Token): void {
  const node = this.stack[this.stack.length - 1];
  if (node?.type !== "inlineMath") throw new Error("A math token closed without its formula.");
  const source = this.sliceSerialize(token);
  const { open, close, display } = delimitersOf(source);
  node.value = source.slice(open.length, source.length - close.length);
  node.data = {
    hName: "span",
    hProperties: {
      className: ["math", display ? "math-display" : "math-inline"],
      dataMathOpen: open,
      dataMathClose: close,
    },
    hChildren: [{ type: "text", value: node.value }],
  };
  this.exit(token);
}

/** The delimiters a formula's source was written with; the rendering keeps them if KaTeX cannot read the formula. */
function delimitersOf(source: string): { open: string; close: string; display: boolean } {
  if (source.startsWith("\\(")) return { open: "\\(", close: "\\)", display: false };
  if (source.startsWith("\\[")) return { open: "\\[", close: "\\]", display: true };
  if (source.startsWith("$$")) return { open: "$$", close: "$$", display: true };
  return { open: "$", close: "$", display: false };
}
