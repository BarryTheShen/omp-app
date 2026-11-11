import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { isRegisteredSearchEngine } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { ENGINE_KEY_PROVIDERS, KEYLESS_ENGINES } from "./search-engines";

describe("the search engines' keys", () => {
  test("every engine omp lists says which key it reads, or that it reads none", () => {
    // An engine a newer omp adds would otherwise show as needing no key, whatever it reads.
    const engines = getBundledModels("web")
      .map((model) => model.id)
      .filter(isRegisteredSearchEngine);
    expect(engines).toContain("tinyfish");
    expect(
      engines.filter((id) => !Object.hasOwn(ENGINE_KEY_PROVIDERS, id) && !KEYLESS_ENGINES.has(id)),
    ).toEqual([]);
  });
});
