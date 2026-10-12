import "katex/dist/katex.min.css";
import "./math.css";

import type { Root } from "mdast";
// remark-parse declares the unified `Data` fields that `remarkMath` sets; this import loads those declarations.
import type {} from "remark-parse";
import type { Plugin } from "unified";
import { mathFromMarkdown } from "./from-markdown";
import { mathSyntax } from "./syntax";

export { rehypeMath } from "./rehype-math";

/** Teaches the Markdown parser the four math forms: `$...$`, `$$...$$`, `\(...\)` and `\[...\]` (see `syntax.ts`). */
export const remarkMath: Plugin<[], Root> = function remarkMath() {
  const data = this.data();
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), mathSyntax()];
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), mathFromMarkdown()];
};
