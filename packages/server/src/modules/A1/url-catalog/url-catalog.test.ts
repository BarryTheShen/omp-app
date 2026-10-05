import { afterEach, describe, expect, test } from "bun:test";
import { AppFailure, UrlCatalogPort, type UrlScheme } from "@omp-app/contracts";
import type { A1PortContext } from "../ports/context";
import { createUrlCatalogRegistration } from "../ports/url-catalog";
import { createUrlCatalog, type UrlCatalogResourceInput } from "./index";

const temporaryDisposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of temporaryDisposers.splice(0)) dispose();
});

function resource(
  scheme: UrlScheme,
  value: string,
  overrides: Partial<UrlCatalogResourceInput> = {},
): UrlCatalogResourceInput {
  return {
    scheme,
    value,
    label: value.length === 0 ? `${scheme} resources` : value,
    kind: scheme,
    source: "omp",
    ...overrides,
  };
}

describe("createUrlCatalog", () => {
  test("lists built-in schemes and app resources while filtering denied metadata", async () => {
    const catalog = createUrlCatalog({
      resources: [
        resource("skill", "deploy", { label: "Deploy skill" }),
        resource("rule", "private", { permission: "denied" }),
        resource("local", "help", { source: "app", kind: "app", label: "Help" }),
      ],
    });

    const result = await catalog.list({ query: "deploy", limit: 10 });

    expect(UrlCatalogPort.methods.list.result.safeParse(result).success).toBe(true);
    expect(result.resources.map((item) => item.uri)).toEqual(["skill://deploy"]);
    expect(result.resources.some((item) => item.value === "private")).toBe(false);
  });

  test("bounds results, ranks fuzzy matches, and invalidates cached revisions", async () => {
    let loads = 0;
    let invalidateSource: (() => void) | undefined;
    const resources = Array.from({ length: 100 }, (_, index) => resource("local", `item-${index}`));
    const catalog = createUrlCatalog({
      resources,
      loadResources: () => {
        loads += 1;
        return resources;
      },
      subscribeInvalidation: (invalidate) => {
        invalidateSource = invalidate;
        return () => {
          invalidateSource = undefined;
        };
      },
    });
    const revisions: string[] = [];
    temporaryDisposers.push(catalog.subscribe((revision) => revisions.push(revision)));

    const first = await catalog.list({ query: "item-9", limit: 50 });
    expect(first.resources[0]?.value).toBe("item-9");
    expect(first.resources.length).toBeLessThanOrEqual(50);
    expect(loads).toBe(1);
    invalidateSource?.();
    const second = await catalog.list({ query: "item-9", limit: 50 });

    expect(second.revision).toBe("url-1");
    expect(revisions).toEqual(["url-1"]);
    expect(loads).toBe(2);
  });

  test("returns a typed cancellation before a provider load starts", async () => {
    const controller = new AbortController();
    controller.abort();
    let loaded = false;
    const catalog = createUrlCatalog({
      loadResources: () => {
        loaded = true;
        return [];
      },
    });

    const error = await catalog
      .list({ query: "", limit: 10 }, controller.signal)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("cancelled");
    expect(loaded).toBe(false);
  });

  test("registers list and refresh through A1.9's helper", () => {
    const catalog = createUrlCatalog();
    const registration = createUrlCatalogRegistration({
      urlCatalog: catalog,
      publish: () => undefined,
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext);

    expect(registration.port).toBe(UrlCatalogPort);
    expect(Object.keys(registration.handlers)).toEqual(["list", "refresh"]);
  });
});
