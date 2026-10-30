import { applyModelPreferenceChange } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ChatModel } from "../chat/store";
import { menuSections } from "./menu";

const model = (provider: string, id: string, name: string): ChatModel => ({ provider, id, name });
/** In the server's order: by provider, each provider's newest first. */
const MODELS = [
  model("anthropic", "claude-opus-5", "Claude Opus 5"),
  model("anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
  model("anthropic", "claude-3-5-sonnet", "Claude Sonnet 3.5"),
  model("openai", "gpt-6", "GPT-6"),
  model("openai", "gpt-4o", "GPT-4o"),
];
const titles = (sections: ReturnType<typeof menuSections>["sections"]) =>
  sections.map(
    (section) => `${section.heading}: ${section.models.map((each) => each.name).join(", ")}`,
  );

describe("menuSections", () => {
  test("Favorites in starred order, Recent without the starred, then each provider in the server's order", () => {
    const { sections, hidden } = menuSections({
      models: MODELS,
      recent: ["openai/gpt-6", "anthropic/claude-opus-5", "openai/gpt-4o"],
      favorites: ["anthropic/claude-opus-5", "openai/gpt-4o"],
      hidden: [],
      query: "",
    });
    expect(titles(sections)).toEqual([
      "Favorites: Claude Opus 5, GPT-4o",
      "Recent: GPT-6",
      "anthropic: Claude Opus 5, Claude Sonnet 5, Claude Sonnet 3.5",
      "openai: GPT-6, GPT-4o",
    ]);
    expect(hidden).toEqual([]);
  });

  test("a hidden model leaves every section and is listed apart; a star or recent of a model gone is skipped", () => {
    const { sections, hidden } = menuSections({
      models: MODELS,
      recent: ["anthropic/claude-3-5-sonnet", "gone/old-model"],
      favorites: ["gone/old-model"],
      hidden: ["anthropic/claude-3-5-sonnet"],
      query: "",
    });
    expect(titles(sections)).toEqual([
      "anthropic: Claude Opus 5, Claude Sonnet 5",
      "openai: GPT-6, GPT-4o",
    ]);
    expect(hidden.map((each) => each.name)).toEqual(["Claude Sonnet 3.5"]);
  });

  test("a search matches every word in the name or provider/id, keeps hidden matches apart, and drops Favorites and Recent", () => {
    const { sections, hidden } = menuSections({
      models: MODELS,
      recent: ["openai/gpt-6"],
      favorites: ["anthropic/claude-sonnet-5"],
      hidden: ["anthropic/claude-3-5-sonnet"],
      query: "  Sonnet  anthropic ",
    });
    expect(titles(sections)).toEqual(["anthropic: Claude Sonnet 5"]);
    expect(hidden.map((each) => each.name)).toEqual(["Claude Sonnet 3.5"]);
  });
});

describe("applyModelPreferenceChange", () => {
  test("starring a hidden model shows it; hiding a starred one unstars it; a star given again keeps its place", () => {
    const start = { favorites: ["a/1", "a/2"], hidden: ["a/3"] };
    expect(applyModelPreferenceChange(start, "a/3", { favorite: true })).toEqual({
      favorites: ["a/1", "a/2", "a/3"],
      hidden: [],
    });
    expect(applyModelPreferenceChange(start, "a/1", { hidden: true })).toEqual({
      favorites: ["a/2"],
      hidden: ["a/3", "a/1"],
    });
    expect(applyModelPreferenceChange(start, "a/1", { favorite: true })).toEqual(start);
  });
});
