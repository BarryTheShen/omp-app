import type { ToolRegistryDescriptor } from "../U3/tool-card/contract";
import { BrowserToolCard } from "./browser";
import { GithubToolRenderer } from "./github";
import { WebSearchToolRenderer } from "./web-search";
/** T4 owns the browser/GitHub/search descriptors; T1 owns read and its URL dispatch claim. */
export const T4_TOOL_DESCRIPTORS = [
  {
    kind: "tool",
    id: "T4.browser",
    owner: "T4",
    title: "Browser",
    covers: ["T4.browser"],
    requires: [],
    match: { by: "name", name: "browser" },
    renderer: BrowserToolCard,
  },
  {
    kind: "tool",
    id: "T4.github",
    owner: "T4",
    title: "GitHub",
    covers: ["T4.github"],
    requires: [],
    match: { by: "name", name: "github" },
    renderer: GithubToolRenderer,
  },
  {
    kind: "tool",
    id: "T4.webSearch",
    owner: "T4",
    title: "Web search",
    covers: ["T4.web-search"],
    requires: [],
    match: { by: "name", name: "web_search" },
    renderer: WebSearchToolRenderer,
  },
] as const satisfies readonly ToolRegistryDescriptor[];

export type T4ToolDescriptor = (typeof T4_TOOL_DESCRIPTORS)[number];
