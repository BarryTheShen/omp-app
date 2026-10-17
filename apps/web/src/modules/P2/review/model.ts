import type { Content, Heading, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkMath } from "@/lib/markdown-math";
import type { PlanDocument, PlanSection } from "../contract";

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export interface PlanHeading {
  readonly id: string;
  readonly text: string;
  readonly level: number;
  readonly sectionId?: string;
}

export interface PlanReviewChunk {
  readonly key: string;
  readonly markdown: string;
  readonly heading: PlanHeading | null;
}

export interface PlanReviewModel {
  readonly headings: readonly PlanHeading[];
}

interface DefinitionSource {
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
}

function slug(value: string, index: number): string {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || `heading-${index + 1}`;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function inlineText(node: Content): string {
  if (node.type === "html") return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return " ";
  if ("children" in node)
    return node.children.map((child) => inlineText(child as Content)).join("");
  return "";
}

function matchingSection(
  heading: Heading,
  text: string,
  sections: readonly PlanSection[],
  used: Set<number>,
): number {
  const line = heading.position?.start.line;
  if (line !== undefined) {
    const atLine = sections.findIndex(
      (section, index) => !used.has(index) && section.start === line - 1,
    );
    if (atLine >= 0) return atLine;
  }
  const normalized = normalizedText(text);
  return sections.findIndex(
    (section, index) => !used.has(index) && normalizedText(section.heading) === normalized,
  );
}

function definitionSources(markdown: string, root: Root): readonly DefinitionSource[] {
  return root.children.flatMap((node) => {
    if (node.type !== "definition" && (node.type as string) !== "footnoteDefinition") return [];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return [];
    return [{ start, end, markdown: markdown.slice(start, end) }];
  });
}

function withDefinitions(
  source: string,
  start: number,
  end: number,
  definitions: readonly DefinitionSource[],
): string {
  const missing = definitions.filter(
    (definition) => definition.start < start || definition.end > end,
  );
  return missing.length === 0
    ? source
    : `${source}\n\n${missing.map((definition) => definition.markdown).join("\n\n")}`;
}

/** Split at U1's remark heading nodes, then render every source slice through U1.4. */
export function planReviewChunks(
  document: PlanDocument,
  anchorPrefix: string,
): readonly PlanReviewChunk[] {
  const root = markdownParser.parse(document.markdown);
  const headings = root.children.filter(
    (node): node is Heading => node.type === "heading" && node.position?.start.offset !== undefined,
  );
  const definitions = definitionSources(document.markdown, root);
  const usedSections = new Set<number>();
  const prefix = `plan-review-${anchorPrefix.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const chunks: PlanReviewChunk[] = [];
  let sourceCursor = 0;

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading) continue;
    const start = heading.position?.start.offset;
    if (start === undefined || start < sourceCursor) continue;
    const nextStart = headings[index + 1]?.position?.start.offset ?? document.markdown.length;
    if (start > sourceCursor) {
      const markdown = document.markdown.slice(sourceCursor, start);
      chunks.push({
        key: `preamble-${sourceCursor}`,
        markdown: withDefinitions(markdown, sourceCursor, start, definitions),
        heading: null,
      });
    }

    const text = heading.children
      .map((child) => inlineText(child as Content))
      .join("")
      .trim();
    if (!text) {
      const markdown = document.markdown.slice(start, nextStart);
      chunks.push({
        key: `unlabelled-${start}`,
        markdown: withDefinitions(markdown, start, nextStart, definitions),
        heading: null,
      });
      sourceCursor = nextStart;
      continue;
    }
    const sectionIndex = matchingSection(heading, text, document.sections, usedSections);
    const section = sectionIndex < 0 ? undefined : document.sections[sectionIndex];
    if (sectionIndex >= 0) usedSections.add(sectionIndex);
    const id = section
      ? `${prefix}-section-${encodeURIComponent(section.id)}`
      : `${prefix}-heading-${index + 1}-${slug(text, index)}`;
    const headingModel: PlanHeading = {
      id,
      text,
      level: heading.depth,
      ...(section === undefined ? {} : { sectionId: section.id }),
    };
    const markdown = document.markdown.slice(start, nextStart);
    chunks.push({
      key: id,
      markdown: withDefinitions(markdown, start, nextStart, definitions),
      heading: headingModel,
    });
    sourceCursor = nextStart;
  }

  if (headings.length === 0) {
    chunks.push({ key: "unsectioned", markdown: document.markdown, heading: null });
  } else if (sourceCursor < document.markdown.length) {
    const markdown = document.markdown.slice(sourceCursor);
    chunks.push({
      key: `trailing-${sourceCursor}`,
      markdown: withDefinitions(markdown, sourceCursor, document.markdown.length, definitions),
      heading: null,
    });
  }
  return chunks;
}

/** Read headings from the exact safe Markdown DOM shown to the person. */
export function planReviewModel(markdownRoot: HTMLElement): PlanReviewModel {
  const sections = Array.from(
    markdownRoot.querySelectorAll<HTMLElement>("[data-plan-heading-anchor]"),
  );
  return {
    headings: sections.flatMap((section) => {
      const element = section.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
      const text = element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (!element || !text) return [];
      return [
        {
          id: section.id,
          text,
          level: Number(element.tagName.slice(1)),
        },
      ];
    }),
  };
}
