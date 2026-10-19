import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DESCRIPTORS } from "../../../registry";
import { createRegistry, isDescriptorAvailable } from "../../../registry-core";
import { createReadToolRenderer } from "../../T1/read";
import { normalizeToolCall, type ToolRendererProps } from "../../U3/tool-card";
import { T4_TOOL_DESCRIPTORS } from "../descriptor";
import {
  T4_LIFECYCLE_FIXTURES,
  T4_URL_FIXTURES,
  type T4DescriptorId,
  type T4LifecycleFixture,
} from "../fixtures/lifecycle";
import { T4_SCRIPTED_LIMITS } from "../fixtures/scripted";
import * as T4 from "../index";
import { WEB_FETCH_DESCRIPTOR } from "../web-fetch";

const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDERS = [
  "No displayable content",
  "Malformed",
  "malformed",
  "Unable to render",
  "unavailable",
  "[object Object]",
  "undefined",
  "NaN",
];
const MODULE_DESCRIPTORS = [...T4_TOOL_DESCRIPTORS, WEB_FETCH_DESCRIPTOR];
const EXPECTED_T4: Readonly<
  Record<string, { covers: readonly string[]; requires: readonly string[] }>
> = {
  "T4.browser": { covers: ["T4.browser"], requires: [] },
  "T4.github": { covers: ["T4.github"], requires: [] },
  "T4.webSearch": { covers: ["T4.web-search"], requires: [] },
  "T4.webFetch": { covers: [], requires: [] },
};
const EXPECTED_PHASES: Readonly<Record<T4DescriptorId, readonly string[]>> = {
  "T4.browser": ["running", "success", "error"],
  "T4.github": ["running", "success"],
  "T4.webSearch": ["running", "success", "error"],
  "T4.webFetch": ["running", "success", "error"],
};
const LIMITED_T4_DESCRIPTORS = ["T4.browser", "T4.github", "T4.webSearch"];
const EXPECTED_CARD_SLOTS: Readonly<Record<T4DescriptorId, string>> = {
  "T4.browser": "t4-browser-card",
  "T4.github": "t4-github-card",
  "T4.webSearch": "t4-web-search-card",
  "T4.webFetch": "t4-web-fetch",
};

afterEach(cleanup);

function openEveryFold(container: HTMLElement) {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const trigger of container.querySelectorAll('button[aria-expanded="false"]'))
      fireEvent.click(trigger);
    for (const disclosure of container.querySelectorAll<HTMLDetailsElement>(
      "details:not([open])",
    )) {
      disclosure.open = true;
      const summary = disclosure.querySelector("summary");
      if (summary) fireEvent.click(summary);
      disclosure.open = true;
    }
  }
}

function expectDisclosuresLinked(container: HTMLElement) {
  for (const trigger of container.querySelectorAll("button[aria-controls]")) {
    const id = trigger.getAttribute("aria-controls") ?? "";
    expect(
      container.ownerDocument.getElementById(id),
      `the disclosure controls #${id}`,
    ).not.toBeNull();
  }
}

function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll("details:not([open]) > :not(summary)"))
    hidden.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ");
}

function renderFixture(fixture: T4LifecycleFixture) {
  const descriptor = MODULE_DESCRIPTORS.find((candidate) => candidate.id === fixture.descriptor);
  if (!descriptor) throw new Error(`No descriptor ${fixture.descriptor}`);
  const Renderer = descriptor.renderer;
  return render(<Renderer {...(fixture.input as ToolRendererProps)} />);
}

function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(MODULE_DIR, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(MODULE_DIR, name), "utf8") }));
}

describe("T4 descriptors and W4 coverage", () => {
  test("pins each descriptor's covers, requires and availability", () => {
    expect(validateRegistry(MODULE_DESCRIPTORS)).toEqual([]);
    for (const descriptor of MODULE_DESCRIPTORS) {
      expect({ covers: descriptor.covers, requires: descriptor.requires }).toEqual(
        EXPECTED_T4[descriptor.id],
      );
      expect(isDescriptorAvailable(descriptor, {})).toBe(true);
    }
  });

  test("composes T4 through the app registry with each of its four inventory rows claimed once", () => {
    const registry = createRegistry(DESCRIPTORS);
    const rows = INVENTORY.filter((row) => row.group === "T4").map((row) => row.id);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(
        registry.descriptors.filter((descriptor) => descriptor.covers.includes(row)),
      ).toHaveLength(1);
    }
    expect(
      registry.descriptors.find((descriptor) => descriptor.id === "T4.webFetch"),
    ).toMatchObject({
      id: WEB_FETCH_DESCRIPTOR.id,
      owner: WEB_FETCH_DESCRIPTOR.owner,
      title: WEB_FETCH_DESCRIPTOR.title,
      covers: WEB_FETCH_DESCRIPTOR.covers,
      requires: WEB_FETCH_DESCRIPTOR.requires,
      match: WEB_FETCH_DESCRIPTOR.match,
    });
  });

  test("pins the explicit public barrel without fixture exports", () => {
    expect(Object.keys(T4).sort()).toEqual(
      [
        "BrowserAction",
        "BrowserScreenshotSchema",
        "BrowserPreludeDetailsSchema",
        "BrowserToolArgsSchema",
        "BrowserToolCard",
        "GhOperation",
        "GhToolArgsSchema",
        "GhToolDetailsSchema",
        "GithubCard",
        "GithubToolRenderer",
        "ReadUrlToolDetailsSchema",
        "SearchCitationSchema",
        "SearchRenderDetailsSchema",
        "SearchResponseSchema",
        "SearchSourceSchema",
        "SearchUsageSchema",
        "T4ReadUrlRenderer",
        "T4_TOOL_DESCRIPTORS",
        "WEB_FETCH_DESCRIPTOR",
        "WebFetchRenderer",
        "WebSearchCard",
        "WebSearchToolRenderer",
        "mapT4Failure",
        "safeRetrievalUrl",
      ].sort(),
    );
  });

  test("T1 owns read while T4 owns only browser, GitHub, web search and web fetch", () => {
    expect(T4_TOOL_DESCRIPTORS.map((descriptor) => descriptor.match)).toEqual([
      { by: "name", name: "browser" },
      { by: "name", name: "github" },
      { by: "name", name: "web_search" },
    ]);
    expect(WEB_FETCH_DESCRIPTOR.match).toEqual({ by: "name", name: "web_fetch" });
    expect(MODULE_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual([
      "T4.browser",
      "T4.github",
      "T4.web-search",
    ]);
    expect(MODULE_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).not.toContain(
      "T4.fetch-read-url-path",
    );
  });

  test("fixture basis distinguishes recordings, older-omp recordings and scripts", () => {
    for (const fixture of T4_LIFECYCLE_FIXTURES) {
      expect(["recorded", "recorded-older-omp", "scripted"]).toContain(fixture.basis);
      if (fixture.basis === "scripted") expect(fixture.name).toContain("scripted");
      if (fixture.basis === "recorded-older-omp")
        expect(fixture.name).toContain("older-omp recording");
    }
    for (const fixture of T4_URL_FIXTURES) {
      expect(["recorded", "scripted"]).toContain(fixture.basis);
      if (fixture.basis === "scripted") expect(fixture.name).toContain("scripted");
    }
  });

  for (const descriptor of MODULE_DESCRIPTORS) {
    test(`${descriptor.id} has only phases supported by its builder result path`, () => {
      const mine = T4_LIFECYCLE_FIXTURES.filter((fixture) => fixture.descriptor === descriptor.id);
      const phases = [...new Set(mine.map((fixture) => fixture.expect.phase))].sort();
      expect(phases).toEqual([...EXPECTED_PHASES[descriptor.id]].sort());
      if (LIMITED_T4_DESCRIPTORS.includes(descriptor.id)) {
        expect(mine.some((fixture) => fixture.size === "large")).toBe(true);
      }
      if (descriptor.id === "T4.webFetch") expect(descriptor.covers).toEqual([]);
    });
  }

  for (const fixture of T4_LIFECYCLE_FIXTURES) {
    test(`normalizes ${fixture.name} and preserves its tool id`, () => {
      const state = normalizeToolCall(fixture.input);
      expect(state).toMatchObject(fixture.expect);
      expect(state.toolCallId).toBe(fixture.input.toolCallId);
      expect(state.argsText).toBe(fixture.input.argsText);
    });
    test(`renders ${fixture.name} with phase and linked disclosures`, () => {
      const { container } = renderFixture(fixture);
      const card = container.querySelector("[data-slot='u3-tool-card']");
      expect(
        container.querySelector(`[data-slot='${EXPECTED_CARD_SLOTS[fixture.descriptor]}']`),
      ).toBeTruthy();
      expect(card?.getAttribute("data-phase")).toBe(fixture.renderedPhase ?? fixture.expect.phase);
      expect(container.querySelector("button[aria-expanded][aria-controls]")).toBeTruthy();
      openEveryFold(container);
      expectDisclosuresLinked(container);
      const text = visibleText(container);
      for (const fact of fixture.shows) expect(text).toContain(fact.replace(/\s+/g, " "));
      for (const placeholder of PLACEHOLDERS) expect(text).not.toContain(placeholder);
    });
  }

  test("browser's long v18.9.1 run console output is folded by TextOutput", () => {
    const fixture = T4_LIFECYCLE_FIXTURES.find(
      (item) =>
        item.name.includes("scripted long console display") && item.expect.phase === "success",
    );
    if (!fixture) throw new Error("No scripted large browser result");
    const result = fixture.input.result as {
      content: Array<{ text?: string }>;
      details: { value: string };
    };
    expect(result.details.value).toBe("done");
    expect(result.content[0]?.text?.split("\n")).toHaveLength(24);
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    expect(visibleText(container)).toContain("Show all 24 lines");
  });

  test("web search source, citation and related-question limits show the omitted counts", () => {
    for (const [name, expected] of [
      ["scripted 33-source", "Showing 32 of 33 sources."],
      ["scripted citation limit", "Showing 32 of 33 citations."],
      ["scripted related-question limit", "Showing 8 of 9 questions."],
    ] as const) {
      const fixture = T4_LIFECYCLE_FIXTURES.find(
        (item) => item.name.includes(name) && item.expect.phase === "success",
      );
      if (!fixture) throw new Error(`No large web-search fixture: ${name}`);
      const { container } = renderFixture(fixture);
      openEveryFold(container);
      expect(visibleText(container)).toContain(expected);
    }
  });

  test("the long web-search answer is bounded at the renderer limit", () => {
    const fixture = T4_LIFECYCLE_FIXTURES.find(
      (item) => item.name.includes("scripted long answer") && item.expect.phase === "success",
    );
    if (!fixture) throw new Error("No long web-search answer fixture");
    const details = (fixture.input.result as { details: { response: { answer: string } } }).details;
    expect(details.response.answer.length).toBeGreaterThan(T4_SCRIPTED_LIMITS.maxAnswerCharacters);
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    expect(container.querySelector("[data-slot='t4-web-search-answer']")?.textContent?.length).toBe(
      T4_SCRIPTED_LIMITS.maxAnswerCharacters,
    );
  });

  test("GitHub's large file-read result is carried from the contents API and bounded in raw details", () => {
    const fixture = T4_LIFECYCLE_FIXTURES.find(
      (item) => item.name.includes("scripted long text-file") && item.expect.phase === "success",
    );
    if (!fixture) throw new Error("No GitHub large file-read fixture");
    const raw = JSON.stringify(fixture.input.result);
    expect(raw.length).toBeGreaterThan(4_000);
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    const preview =
      container.querySelector("[data-testid='t4-github-raw-details'] pre")?.textContent ?? "";
    expect(preview.length).toBe(4_000);
    expect(preview).toContain("README fixture line 1");
  });

  test("dispatches recorded and empty URL read results through T1 and checks T4's URL view", () => {
    for (const fixture of T4_URL_FIXTURES) {
      const result = fixture.sample.result as {
        content: Array<{ type: string; text?: string }>;
        details: { kind: string; url?: string; finalUrl?: string; contentType?: string };
      };
      const rendererProps = {
        type: "tool-call",
        toolCallId: "t4-url-1",
        toolName: "read",
        args: fixture.sample.args,
        argsText: JSON.stringify(fixture.sample.args),
        result: fixture.sample.result,
        isError: fixture.sample.isError,
        status: { type: "complete" },
      } as unknown as ToolRendererProps;
      const calls: unknown[] = [];
      const urlRenderer = (
        props: Parameters<NonNullable<Parameters<typeof createReadToolRenderer>[0]>>[0],
      ) => {
        calls.push(props);
        return T4.T4ReadUrlRenderer(props);
      };
      const Renderer = createReadToolRenderer(urlRenderer);
      const { container } = render(<Renderer {...rendererProps} />);
      expect(calls).toHaveLength(1);
      expect(container.querySelector("[data-slot='t4-url-read']")).toBeTruthy();
      openEveryFold(container);
      expectDisclosuresLinked(container);
      const title = container.querySelector("[data-url-title]")?.textContent ?? "";
      const finalUrl = result.details.finalUrl ?? result.details.url;
      expect(title).toContain(new URL(finalUrl ?? "https://example.test").host);
      expect(
        container
          .querySelector("[data-slot='t4-url-read-body'] header a[href]")
          ?.getAttribute("href"),
      ).toBe(finalUrl);
      expect(
        container.querySelector("[data-slot='u3-tool-card']")?.getAttribute("data-phase"),
      ).toBe(fixture.sample.isError ? "error" : "success");
      if (result.details.contentType) {
        expect(container.querySelector("[data-url-metadata]")?.textContent).toContain(
          result.details.contentType,
        );
      }
      if (fixture.shows.length > 0) {
        const text = visibleText(container);
        for (const fact of fixture.shows) expect(text).toContain(fact.replace(/\s+/g, " "));
      }
      cleanup();
    }
  });

  test("no-answer, no-source, provider-failure and running messages have explicit results", () => {
    const byName = (fragment: string, phase: string) => {
      const fixture = T4_LIFECYCLE_FIXTURES.find(
        (item) => item.name.includes(fragment) && item.expect.phase === phase,
      );
      if (!fixture) throw new Error(`Missing T4 result fixture: ${fragment}`);
      return renderFixture(fixture);
    };
    const noAnswer = byName("real sources-only", "success");
    openEveryFold(noAnswer.container);
    expect(visibleText(noAnswer.container)).toContain("No answer was returned.");
    cleanup();
    const noSources = byName("scripted answer with no sources", "success");
    openEveryFold(noSources.container);
    expect(visibleText(noSources.container)).toContain("No sources were returned for this search.");
    cleanup();
    const providerFailure = byName("scripted provider-unavailable", "success");
    expect(
      providerFailure.container
        .querySelector("[data-slot='u3-tool-card']")
        ?.getAttribute("data-phase"),
    ).toBe("error");
    expect(visibleText(providerFailure.container)).toContain("No web search model configured.");
    cleanup();
    const waiting = byName("real answer with ten sources", "running");
    openEveryFold(waiting.container);
    expect(visibleText(waiting.container)).toContain("Waiting for search results…");
  });

  test("matches retrieval source links to their recorded details, never answer prose", () => {
    const fixture = T4_LIFECYCLE_FIXTURES.find(
      (item) =>
        item.name.includes("real answer with ten sources") && item.expect.phase === "success",
    );
    if (!fixture) throw new Error("No recorded sourced search fixture");
    const result = fixture.input.result as {
      content: Array<{ text?: string }>;
      details: { response: { sources: Array<{ url: string }> } };
    };
    expect(result.content[0]?.text).toContain("## Sources");
    expect(result.content[0]?.text).toContain("10 sources");
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    // The count is drawn twice in the body (the header row and the usage chips): pin the header row itself.
    expect(
      container.querySelector("[data-slot='t4-web-search-body'] > div:first-child")?.textContent,
    ).toContain("10 results");
    expect(container.querySelector("[data-slot='t4-web-search-usage']")?.textContent).toContain(
      "10 results",
    );
    const sourceLinks = [...container.querySelectorAll("[data-slot='t4-web-search-sources'] a")];
    expect(sourceLinks.length).toBe(10);
    expect(sourceLinks.map((link) => link.getAttribute("href"))).toEqual(
      result.details.response.sources.map((source) => source.url),
    );
  });

  test("keeps T4 sources free of network, browser, shell, filesystem and dynamic-registry access", () => {
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(/(?:from|import|require)\s*\(?\s*["'][^"']*registry/);
      expect(file.text).not.toMatch(
        /(?:from|import|require)\s*\(?\s*["'](?:fs|fs\/promises|node:fs|node:child_process|child_process|playwright|@playwright[^"']*)["']/,
      );
      expect(file.text).not.toMatch(
        /\b(?:fetch|XMLHttpRequest|Bun\.spawn|Bun\.file|Bun\.write|readFile|execFile)\s*\(/,
      );
      expect(file.text).not.toMatch(/WebSocket|\bgh\s*\(/);
    }
  });
});
