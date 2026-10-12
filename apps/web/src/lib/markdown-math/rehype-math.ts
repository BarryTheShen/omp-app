import type { Element, ElementContent, Root, RootContent } from "hast";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import katex from "katex";

/**
 * Typesets the formulas the text parser left as `math` elements, with KaTeX. KaTeX's HTML is parsed into elements,
 * never inserted as a string, and KaTeX runs with `trust: false`, so a formula cannot add a link, an attribute or a
 * script. A formula KaTeX cannot read shows its source as plain text, not as an error.
 */
export function rehypeMath(): (tree: Root) => void {
  return typesetIn;
}

/** Replaces the formulas among a node's children with their typeset forms, and does the same in the elements below. */
function typesetIn(parent: { children: RootContent[] }): void {
  const children = parent.children.flatMap<RootContent>((child) => {
    if (child.type !== "element") return [child];
    if (!isFormula(child)) {
      typesetIn(child);
      return [child];
    }
    return formulaNodes(child);
  });
  parent.children = children;
}

function isFormula(element: Element): boolean {
  const classes = element.properties.className;
  return Array.isArray(classes) && classes.includes("math");
}

function isElementContent(node: RootContent): node is ElementContent {
  return node.type !== "doctype";
}

function formulaNodes(formula: Element): ElementContent[] {
  const classes = formula.properties.className;
  const display = Array.isArray(classes) && classes.includes("math-display");
  const tex = formula.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      strict: "ignore",
      throwOnError: true,
      trust: false,
    });
    return fromHtmlIsomorphic(html, { fragment: true }).children.filter(isElementContent);
  } catch {
    const open = String(formula.properties.dataMathOpen);
    const close = String(formula.properties.dataMathClose);
    return [
      {
        type: "element",
        tagName: "span",
        properties: { className: ["math-source"] },
        children: [{ type: "text", value: `${open}${tex}${close}` }],
      },
    ];
  }
}
