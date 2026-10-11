import { AppFailure, FolderPath } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionCatalog, ExtensionCatalogSnapshot } from "../../catalog";
import { ExtensionControlCenter } from "../../extensions";

const folder = FolderPath.parse("/workspace/project");
const snapshot: ExtensionCatalogSnapshot = {
  revision: "revision-1",
  extensions: [
    {
      id: "plugin-one",
      name: "Plugin One",
      provider: "demo",
      source: "plugin",
      version: "1.0.0",
      enabled: true,
      shadowed: false,
      capabilities: ["tools"],
      description: "Untrusted **metadata** text",
    },
  ],
  skills: [
    {
      id: "skill-one",
      name: "Skill One",
      provider: "demo",
      source: "skill",
      enabled: false,
      shadowed: false,
      capabilities: [],
    },
  ],
  prompts: [{ name: "prompt-one", provider: "demo", source: "extension", enabled: true }],
  sources: [{ source: "plugin", provider: "demo", total: 1, enabled: 1, shadowed: 0 }],
  truncated: false,
};

function catalog(): { catalog: ExtensionCatalog; reload: ReturnType<typeof vi.fn> } {
  const reload = vi.fn(async () => snapshot);
  return {
    reload,
    catalog: {
      list: vi.fn(async () => snapshot),
      reload,
      subscribe: vi.fn(async () => async () => undefined),
    },
  };
}

afterEach(() => cleanup());

describe("ExtensionControlCenter", () => {
  test("loads provider tabs, filters search and inspects untrusted metadata safely", async () => {
    const fake = catalog();
    render(
      <ExtensionControlCenter
        catalog={fake.catalog}
        folder={folder}
        capabilities={{ "host.extension-catalog": { state: "available", via: "host" } }}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    await waitFor(() => expect(screen.getByTestId("extension-item-plugin-one")).toBeTruthy());
    fireEvent.click(screen.getByTestId("extension-item-plugin-one"));
    expect(screen.getByTestId("extension-inspector").textContent).toContain(
      "Untrusted **metadata** text",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search extensions" }), {
      target: { value: "missing" },
    });
    expect(screen.getByText("No matching plugins.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search extensions" }), {
      target: { value: "plugin" },
    });
    expect(screen.getByTestId("extension-item-plugin-one")).toBeTruthy();
  });

  test("an empty tab says what is missing in its own words, and a search with no result says so", async () => {
    const empty: ExtensionCatalogSnapshot = {
      revision: "revision-empty",
      extensions: [],
      skills: [],
      prompts: [],
      sources: [],
      truncated: false,
    };
    const emptyCatalog: ExtensionCatalog = {
      list: vi.fn(async () => empty),
      reload: vi.fn(async () => empty),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(
      <ExtensionControlCenter
        catalog={emptyCatalog}
        folder={folder}
        capabilities={{ "host.extension-catalog": { state: "available", via: "host" } }}
      />,
    );
    await waitFor(() => expect(screen.getByText("No extensions installed.")).toBeTruthy());
    fireEvent.click(screen.getByTestId("extension-tab-skills"));
    await waitFor(() => expect(screen.getByText("No skills found.")).toBeTruthy());
    fireEvent.click(screen.getByTestId("extension-tab-prompts"));
    await waitFor(() => expect(screen.getByText("No prompts found.")).toBeTruthy());
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    await waitFor(() => expect(screen.getByText("No plugins installed.")).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "Search extensions" }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matching plugins.")).toBeTruthy();
    expect(screen.queryByText("No matching providers.")).toBeNull();
  });

  test("a failed load shows its error, and no tab says it is empty", async () => {
    const failure = () =>
      Promise.reject(
        new AppFailure({ code: "internal", message: "The host stopped.", retryable: true }),
      );
    const failing: ExtensionCatalog = {
      list: vi.fn(failure),
      reload: vi.fn(failure),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(
      <ExtensionControlCenter
        catalog={failing}
        folder={folder}
        capabilities={{ "host.extension-catalog": { state: "available", via: "host" } }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("extension-catalog-error")).toBeTruthy());
    expect(screen.queryByText(/^No (matching|extensions|skills|prompts|plugins)/)).toBeNull();
  });

  test("reloads through the typed catalog and gates unavailable capability", async () => {
    const fake = catalog();
    render(
      <ExtensionControlCenter
        catalog={fake.catalog}
        folder={folder}
        capabilities={{ "host.extension-catalog": { state: "available", via: "host" } }}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    await waitFor(() => expect(screen.getByTestId("extension-item-plugin-one")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reload extension catalog" }));
    await waitFor(() => expect(fake.reload).toHaveBeenCalledWith(folder));
    cleanup();
    render(<ExtensionControlCenter catalog={fake.catalog} folder={folder} capabilities={{}} />);
    await waitFor(() => expect(screen.getByTestId("extension-unavailable")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Reload extension catalog" })).toBeNull();
  });

  test("the inspector asks for an item, not a provider, when nothing is selected", async () => {
    const fake = catalog();
    render(
      <ExtensionControlCenter
        catalog={fake.catalog}
        folder={folder}
        capabilities={{ "host.extension-catalog": { state: "available", via: "host" } }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Select an item to see its details.")).toBeTruthy(),
    );
    expect(screen.queryByText(/Select a provider/)).toBeNull();
  });

  test("the open provider tab reports aria-selected and the others report false", () => {
    const fake = catalog();
    render(
      <ExtensionControlCenter
        catalog={fake.catalog}
        folder={folder}
        capabilities={{ "host.extension-catalog": { state: "available", via: "host" } }}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    expect(screen.getByTestId("extension-tab-plugins").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("extension-tab-extensions").getAttribute("aria-selected")).toBe(
      "false",
    );
  });
});
