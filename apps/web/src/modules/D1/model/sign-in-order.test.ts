import { describe, expect, test } from "vitest";
import type { ModelDescriptor } from "../contract";
import { groupByProvider, orderBySignIn } from "./sign-in-order";

function model(provider: string, id: string, signIn?: ModelDescriptor["signIn"]): ModelDescriptor {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: null,
    maxTokens: null,
    thinkingEfforts: [],
    availability: "available",
    description: "General-purpose model",
    ...(signIn === undefined ? {} : { signIn }),
  };
}

describe("orderBySignIn", () => {
  test("a login comes first, then an API key, then none, and a provider the app cannot tell comes last", () => {
    const ordered = orderBySignIn([
      model("openai", "gpt"),
      model("ollama", "local", "none"),
      model("openai-codex", "codex-1", "login"),
      model("anthropic", "claude", "api-key"),
    ]);
    expect(ordered.map((entry) => entry.provider)).toEqual([
      "openai-codex",
      "anthropic",
      "ollama",
      "openai",
    ]);
  });

  test("one provider's models stay together, in the order they came", () => {
    const ordered = orderBySignIn([
      model("openai", "b", "api-key"),
      model("anthropic", "x", "login"),
      model("openai", "a", "api-key"),
    ]);
    expect(ordered.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "anthropic/x",
      "openai/b",
      "openai/a",
    ]);
  });
});

describe("groupByProvider", () => {
  test("groups consecutive models by provider, so each provider is one group", () => {
    const groups = groupByProvider(
      orderBySignIn([
        model("anthropic", "claude", "api-key"),
        model("anthropic", "haiku", "api-key"),
        model("openai", "gpt", "api-key"),
      ]),
    );
    expect(groups.map((group) => [group.provider, group.models.length])).toEqual([
      ["anthropic", 2],
      ["openai", 1],
    ]);
  });
});
