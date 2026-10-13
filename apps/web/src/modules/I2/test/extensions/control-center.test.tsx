import { AppFailure, FolderPath } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** The accessible name of a provider tab: its label, and a count only once a snapshot was read. */
function tabLabel(id: "extensions" | "skills" | "prompts" | "plugins"): string | null {
  return screen.getByTestId(`extension-tab-${id}`).getAttribute("aria-label");
}

const available = { "host.extension-catalog": { state: "available", via: "host" } } as const;
const hostStopped = () =>
  Promise.reject(
    new AppFailure({ code: "internal", message: "The host stopped.", retryable: true }),
  );
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

  test("two copies of one plugin share an id: each row selects and shows only its own copy", async () => {
    const copies: ExtensionCatalogSnapshot = {
      ...snapshot,
      extensions: [
        {
          id: "shadowed",
          name: "Shadowed",
          provider: "demo",
          source: "plugin",
          version: "1.0.0",
          enabled: true,
          shadowed: true,
          capabilities: [],
        },
        {
          id: "shadowed",
          name: "Shadowed",
          provider: "demo",
          source: "plugin",
          version: "2.0.0",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
      ],
      sources: [{ source: "plugin", provider: "demo", total: 2, enabled: 2, shadowed: 1 }],
    };
    const fake: ExtensionCatalog = {
      list: vi.fn(async () => copies),
      reload: vi.fn(async () => copies),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={fake} folder={folder} capabilities={available} />);
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    const list = await screen.findByRole("list", { name: "plugins results" });
    const [first, second] = within(list).getAllByRole("button");
    if (first === undefined || second === undefined) throw new Error("two rows were expected");
    fireEvent.click(second);
    expect(screen.getByTestId("extension-inspector").textContent).toContain("2.0.0");
    expect(screen.getByTestId("extension-inspector").textContent).not.toContain("1.0.0");
    expect(second.className).toContain("bg-accent");
    expect(first.className).not.toContain("bg-accent");
    fireEvent.click(first);
    expect(screen.getByTestId("extension-inspector").textContent).toContain("1.0.0");
    expect(first.className).toContain("bg-accent");
    expect(second.className).not.toContain("bg-accent");
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
    await waitFor(() => expect(screen.getAllByText("The host stopped.").length).toBeGreaterThan(0));
    expect(screen.queryByText(/^No (matching|extensions|skills|prompts|plugins)/)).toBeNull();
  });

  test("the Prompts tab counts prompts, not the extensions beside them", async () => {
    const mixed: ExtensionCatalogSnapshot = {
      revision: "revision-prompts",
      extensions: [
        {
          id: "extension-one",
          name: "Extension One",
          provider: "demo",
          source: "extension",
          version: "1.0.0",
          enabled: true,
          shadowed: false,
          capabilities: ["tools"],
          description: "One extension",
        },
      ],
      skills: [],
      prompts: [
        { name: "prompt-one", provider: "demo", source: "extension", enabled: true },
        { name: "prompt-two", provider: "demo", source: "extension", enabled: true },
      ],
      sources: [{ source: "extension", provider: "demo", total: 1, enabled: 1, shadowed: 0 }],
      truncated: false,
    };
    const withPrompts: ExtensionCatalog = {
      list: vi.fn(async () => mixed),
      reload: vi.fn(async () => mixed),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(
      <ExtensionControlCenter catalog={withPrompts} folder={folder} capabilities={available} />,
    );
    await waitFor(() => expect(tabLabel("prompts")).toBe("Prompts, 2 items"));
    expect(tabLabel("extensions")).toBe("Extensions, 1 item");
  });

  test("a tab names no count while the catalog is loading", () => {
    const pending: ExtensionCatalog = {
      list: vi.fn(() => new Promise<ExtensionCatalogSnapshot>(() => undefined)),
      reload: vi.fn(() => new Promise<ExtensionCatalogSnapshot>(() => undefined)),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={pending} folder={folder} capabilities={available} />);
    expect(tabLabel("extensions")).toBe("Extensions");
    expect(tabLabel("skills")).toBe("Skills");
    expect(tabLabel("prompts")).toBe("Prompts");
    expect(tabLabel("plugins")).toBe("Plugins");
  });

  test("a tab names no count after a failed load", async () => {
    const failing: ExtensionCatalog = {
      list: vi.fn(hostStopped),
      reload: vi.fn(hostStopped),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={failing} folder={folder} capabilities={available} />);
    await waitFor(() => expect(screen.getAllByText("The host stopped.").length).toBeGreaterThan(0));
    expect(tabLabel("extensions")).toBe("Extensions");
    expect(tabLabel("plugins")).toBe("Plugins");
  });

  test("a failed load shows its sentence once", async () => {
    const failing: ExtensionCatalog = {
      list: vi.fn(hostStopped),
      reload: vi.fn(hostStopped),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={failing} folder={folder} capabilities={available} />);
    await waitFor(() => expect(screen.getAllByText("The host stopped.").length).toBeGreaterThan(0));
    expect(screen.getAllByText("The host stopped.")).toHaveLength(1);
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

  test("says where each item came from in plain words; the raw provider name is only in the details", async () => {
    const sources: ExtensionCatalogSnapshot = {
      revision: "revision-sources",
      extensions: [
        {
          id: "own-extension",
          name: "Own Extension",
          provider: "native",
          source: "extension",
          enabled: true,
          shadowed: false,
          capabilities: ["tools"],
        },
        {
          id: "plugin-tool",
          name: "Plugin Tool",
          provider: "plugin-package",
          source: "plugin",
          enabled: true,
          shadowed: false,
          capabilities: ["tools"],
        },
      ],
      skills: [
        {
          id: "own-skill",
          name: "Own Skill",
          provider: "native",
          source: "skill",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
        {
          id: "managed-skill",
          name: "Managed Skill",
          provider: "omp-managed",
          source: "skill",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
      ],
      prompts: [],
      sources: [],
      truncated: false,
    };
    const fake: ExtensionCatalog = {
      list: vi.fn(async () => sources),
      reload: vi.fn(async () => sources),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={fake} folder={folder} capabilities={available} />);
    await waitFor(() => expect(screen.getByTestId("extension-item-own-extension")).toBeTruthy());
    expect(screen.getByTestId("extension-item-own-extension").textContent).toContain(
      "From your extensions folder",
    );
    expect(screen.queryByText("native")).toBeNull();

    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    await waitFor(() => expect(screen.getByTestId("extension-item-plugin-tool")).toBeTruthy());
    expect(screen.getByTestId("extension-item-plugin-tool").textContent).toContain("From a plugin");

    fireEvent.click(screen.getByTestId("extension-tab-skills"));
    await waitFor(() => expect(screen.getByTestId("extension-item-own-skill")).toBeTruthy());
    expect(screen.getByTestId("extension-item-own-skill").textContent).toContain(
      "From your skills folder",
    );
    expect(screen.getByTestId("extension-item-managed-skill").textContent).toContain(
      "Managed by omp",
    );

    fireEvent.click(screen.getByTestId("extension-item-own-skill"));
    const inspector = screen.getByTestId("extension-inspector").textContent ?? "";
    expect(inspector).toContain("From your skills folder");
    expect(inspector).toContain("native");
  });
});
