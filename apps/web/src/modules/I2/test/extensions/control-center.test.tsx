import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ExtensionCatalog,
  ExtensionCatalogSnapshot,
  MarketplacePort,
  MarketplaceResult,
} from "../../catalog";
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
      marketplacePluginId: "plugin-one@demo-market",
      marketplaceScope: "project",
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
          name: "Copy",
          provider: "demo",
          source: "plugin",
          version: "1.0.0",
          enabled: true,
          shadowed: true,
          capabilities: [],
        },
        {
          id: "shadowed",
          name: "Copy",
          provider: "demo",
          source: "plugin",
          version: "2.0.0",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
        {
          id: "unique",
          name: "Unique",
          provider: "demo",
          source: "plugin",
          version: "3.0.0",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
      ],
      sources: [{ source: "plugin", provider: "demo", total: 3, enabled: 3, shadowed: 1 }],
    };
    const fake: ExtensionCatalog = {
      list: vi.fn(async () => copies),
      reload: vi.fn(async () => copies),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={fake} folder={folder} capabilities={available} />);
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    const list = await screen.findByRole("list", { name: "plugins results" });
    const first = within(list).getByRole("button", { name: /1\.0\.0/ });
    const second = within(list).getByRole("button", { name: /2\.0\.0/ });
    const unique = within(list).getByRole("button", { name: /Unique/ });
    expect(first.textContent?.match(/Shadowed/g) ?? []).toHaveLength(1);
    expect(second.textContent?.match(/Shadowed/g) ?? []).toHaveLength(0);
    expect(first.textContent).toContain("1.0.0");
    expect(second.textContent).toContain("2.0.0");
    expect(unique.textContent).toContain("Unique");
    expect(unique.textContent).not.toContain("3.0.0");
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

  test("a unique plugin beside duplicate copies has no version, while each duplicate row shows one", async () => {
    const mixed: ExtensionCatalogSnapshot = {
      ...snapshot,
      extensions: [
        ...snapshot.extensions,
        {
          id: "shared",
          name: "Copy",
          provider: "demo",
          source: "plugin",
          version: "1.0.0",
          enabled: true,
          shadowed: true,
          capabilities: [],
        },
        {
          id: "shared",
          name: "Copy",
          provider: "demo",
          source: "plugin",
          version: "2.0.0",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
      ],
      sources: [{ source: "plugin", provider: "demo", total: 3, enabled: 3, shadowed: 1 }],
    };
    const fake: ExtensionCatalog = {
      list: vi.fn(async () => mixed),
      reload: vi.fn(async () => mixed),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={fake} folder={folder} capabilities={available} />);
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    const list = await screen.findByRole("list", { name: "plugins results" });
    expect(within(list).getByRole("button", { name: /Plugin One/ }).textContent).not.toContain(
      "1.0.0",
    );
    expect(within(list).getByRole("button", { name: /1.0.0/ }).textContent).toContain("1.0.0");
    expect(within(list).getByRole("button", { name: /2.0.0/ }).textContent).toContain("2.0.0");
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
  test("confirms the exact marketplace target, renders omp's reply and reloads its state", async () => {
    const fake = catalog();
    const threadId = ThreadId.parse("thread-i2-toggle");
    const marketplace = {
      capability: "host.command-gateway",
      run: vi.fn(async () => ({
        operation: "plugins-disable",
        status: "completed",
        agentInvoked: false,
        promptSettled: true,
        sessionSettled: true,
        outputs: [{ text: "Disabled plugin-one@demo-market" }],
        sessionUpdates: [],
        configUpdates: [],
      })),
    } as unknown as MarketplacePort;
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={fake.catalog}
        folder={folder}
        marketplace={marketplace}
        threadId={threadId}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    fireEvent.click(screen.getByRole("button", { name: "Disable plugin" }));
    const group = await screen.findByRole("group", { name: "Disable plugin" });
    fireEvent.click(within(group).getByRole("button", { name: "Disable plugin" }));
    await waitFor(() =>
      expect(marketplace.run).toHaveBeenCalledWith(
        {
          operation: "plugins-disable",
          threadId,
          name: "plugin-one",
          marketplace: "demo-market",
          scope: "project",
        },
        { signal: expect.anything() },
      ),
    );
    expect(screen.queryByRole("group", { name: "Disable plugin" })).toBeNull();
    expect(
      within(screen.getByTestId("extension-inspector")).getByText("Enabled", { exact: true }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("extension-inspector")).getByText("Scope").parentElement
        ?.textContent,
    ).toContain("Project");
    expect(fake.reload).toHaveBeenCalledTimes(1);
  });

  test("switching away from a plugin cancels its pending confirmation", async () => {
    const twoPlugins: ExtensionCatalogSnapshot = {
      ...snapshot,
      extensions: [
        ...snapshot.extensions.slice(0, 1),
        {
          id: "plugin-two",
          name: "Plugin Two",
          provider: "other",
          source: "plugin",
          marketplacePluginId: "plugin-two@other-market",
          marketplaceScope: "user",
          version: "2.0.0",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
      ],
      sources: [
        { source: "plugin", provider: "demo", total: 1, enabled: 1, shadowed: 0 },
        { source: "plugin", provider: "other", total: 1, enabled: 1, shadowed: 0 },
      ],
    };
    const marketplace = {
      capability: "host.command-gateway",
      run: vi.fn(),
    } as unknown as MarketplacePort;
    const catalogWithTwoPlugins: ExtensionCatalog = {
      list: vi.fn(async () => twoPlugins),
      reload: vi.fn(async () => twoPlugins),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={catalogWithTwoPlugins}
        folder={folder}
        marketplace={marketplace}
        threadId={ThreadId.parse("thread-i2-toggle")}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    fireEvent.click(screen.getByRole("button", { name: "Disable plugin" }));
    await screen.findByRole("group", { name: "Disable plugin" });

    fireEvent.click(screen.getByTestId("extension-item-plugin-two"));
    fireEvent.click(screen.getByTestId("extension-item-plugin-one"));

    expect(screen.queryByRole("group", { name: "Disable plugin" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disable plugin" })).toBeTruthy();
    expect(marketplace.run).not.toHaveBeenCalled();
  });

  test("a cancelled confirmation sends no plugin command", async () => {
    const fake = catalog();
    const marketplace = {
      capability: "host.command-gateway",
      run: vi.fn(),
    } as unknown as MarketplacePort;
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={fake.catalog}
        folder={folder}
        marketplace={marketplace}
        threadId={ThreadId.parse("thread-i2-toggle")}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    fireEvent.click(screen.getByRole("button", { name: "Disable plugin" }));
    await screen.findByRole("group", { name: "Disable plugin" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(marketplace.run).not.toHaveBeenCalled();
    expect(fake.reload).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Disable plugin" })).toBeNull();
  });

  test("a failed omp reply is an alert, keeps the catalog state and still reloads", async () => {
    const fake = catalog();
    const refusal = 'Plugin "plugin-one@demo-market" is not installed';
    const marketplace = {
      capability: "host.command-gateway",
      run: vi.fn(async () => ({
        operation: "plugins-disable",
        status: "completed",
        agentInvoked: false,
        promptSettled: true,
        sessionSettled: true,
        failure: { message: refusal },
        outputs: [{ text: refusal }],
        sessionUpdates: [],
        configUpdates: [],
      })),
    } as unknown as MarketplacePort;
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={fake.catalog}
        folder={folder}
        marketplace={marketplace}
        threadId={ThreadId.parse("thread-i2-toggle")}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    fireEvent.click(screen.getByRole("button", { name: "Disable plugin" }));
    const group = await screen.findByRole("group", { name: "Disable plugin" });
    fireEvent.click(within(group).getByRole("button", { name: "Disable plugin" }));
    const inspector = screen.getByTestId("extension-inspector");
    expect((await within(inspector).findByRole("alert")).textContent).toBe(refusal);
    expect(within(inspector).getByText("Enabled", { exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable plugin" })).toBeTruthy();
    expect(fake.reload).toHaveBeenCalledTimes(1);
  });

  test("a shadowed marketplace copy has the specified disabled reason", async () => {
    const shadowed = {
      ...snapshot,
      extensions: snapshot.extensions.map((item) => ({ ...item, shadowed: true })),
    };
    const fake: ExtensionCatalog = {
      list: vi.fn(async () => shadowed),
      reload: vi.fn(async () => shadowed),
      subscribe: vi.fn(async () => async () => undefined),
    };
    const marketplace = {
      capability: "host.command-gateway",
      run: vi.fn(),
    } as unknown as MarketplacePort;
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={fake}
        folder={folder}
        marketplace={marketplace}
        threadId={ThreadId.parse("thread-i2-toggle")}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    expect(
      (screen.getByRole("button", { name: "Disable plugin" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        "Another copy of this plugin is used instead, so this one cannot be changed here.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disable plugin" }));
    expect(marketplace.run).not.toHaveBeenCalled();
  });

  test("shows the action-specific busy name and aria-busy while omp is changing the plugin", async () => {
    const fake = catalog();
    const deferred = Promise.withResolvers<MarketplaceResult>();
    const marketplace = {
      capability: "host.command-gateway",
      run: vi.fn(() => deferred.promise),
    } as unknown as MarketplacePort;
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={fake.catalog}
        folder={folder}
        marketplace={marketplace}
        threadId={ThreadId.parse("thread-i2-toggle")}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    fireEvent.click(screen.getByRole("button", { name: "Disable plugin" }));
    const group = await screen.findByRole("group", { name: "Disable plugin" });
    fireEvent.click(within(group).getByRole("button", { name: "Disable plugin" }));
    const busy = await screen.findByRole("button", { name: "Working…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    deferred.resolve({
      operation: "plugins-disable",
      status: "completed",
      agentInvoked: false,
      promptSettled: true,
      sessionSettled: true,
      outputs: [{ text: "Disabled plugin-one@demo-market" }],
      sessionUpdates: [],
      configUpdates: [],
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Working…" })).toBeNull());
  });

  test("enables a disabled plugin through the typed user/project scope request", async () => {
    const disabledSnapshot: ExtensionCatalogSnapshot = {
      ...snapshot,
      extensions: snapshot.extensions.map((item) => ({ ...item, enabled: false })),
    };
    const fake: ExtensionCatalog = {
      list: vi.fn(async () => disabledSnapshot),
      reload: vi.fn(async () => disabledSnapshot),
      subscribe: vi.fn(async () => async () => undefined),
    };
    const marketplace = {
      capability: "host.command-gateway",
      run: vi.fn(async () => ({
        operation: "plugins-enable",
        status: "completed",
        agentInvoked: false,
        promptSettled: true,
        sessionSettled: true,
        outputs: [{ text: "Enabled plugin-one@demo-market" }],
        sessionUpdates: [],
        configUpdates: [],
      })),
    } as unknown as MarketplacePort;
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={fake}
        folder={folder}
        marketplace={marketplace}
        threadId={ThreadId.parse("thread-i2-toggle")}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    fireEvent.click(screen.getByRole("button", { name: "Enable plugin" }));
    const group = await screen.findByRole("group", { name: "Enable plugin" });
    expect(document.activeElement).toBe(within(group).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(group).getByRole("button", { name: "Enable plugin" }));
    await waitFor(() =>
      expect(marketplace.run).toHaveBeenCalledWith(
        {
          operation: "plugins-enable",
          threadId: ThreadId.parse("thread-i2-toggle"),
          name: "plugin-one",
          marketplace: "demo-market",
          scope: "project",
        },
        { signal: expect.anything() },
      ),
    );
  });

  test("disables the control when the chat or U4 dialog host is missing", async () => {
    const fake = catalog();
    const marketplace = { capability: "host.command-gateway", run: vi.fn() } as never;
    render(
      <ExtensionControlCenter
        capabilities={{
          "host.extension-catalog": { state: "available", via: "host" },
          "host.command-gateway": { state: "available", via: "host" },
        }}
        catalog={fake.catalog}
        folder={folder}
        marketplace={marketplace}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    expect(
      (screen.getByRole("button", { name: "Disable plugin" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText("Open a chat first: plugins are changed through a running chat."),
    ).toBeTruthy();
  });

  test("uses the command capability explanation when the command gateway is unavailable", async () => {
    const fake = catalog();
    render(
      <ExtensionControlCenter
        capabilities={{ "host.extension-catalog": { state: "available", via: "host" } }}
        catalog={fake.catalog}
        folder={folder}
        marketplace={{ capability: "host.command-gateway", run: vi.fn() } as never}
        threadId={ThreadId.parse("thread-i2-toggle")}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-plugin-one"));
    expect(
      screen.getByText(
        "Plugin operations is unavailable until the required host capability is connected.",
      ),
    ).toBeTruthy();
  });

  test("shows the exact source-specific explanations for non-marketplace items", async () => {
    const mixed: ExtensionCatalogSnapshot = {
      ...snapshot,
      extensions: [
        {
          id: "native-extension",
          name: "Native extension",
          provider: "native",
          source: "extension",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
        {
          id: "unlinked-plugin-package",
          name: "Unlinked plugin",
          provider: "package-name",
          source: "plugin",
          marketplaceScope: "user",
          enabled: true,
          shadowed: false,
          capabilities: [],
        },
      ],
      prompts: [{ name: "prompt-one", provider: "native", source: "extension", enabled: true }],
    };
    const fake: ExtensionCatalog = {
      list: vi.fn(async () => mixed),
      reload: vi.fn(async () => mixed),
      subscribe: vi.fn(async () => async () => undefined),
    };
    render(<ExtensionControlCenter catalog={fake} folder={folder} capabilities={available} />);
    fireEvent.click(screen.getByTestId("extension-tab-extensions"));
    fireEvent.click(await screen.findByTestId("extension-item-native-extension"));
    expect(
      screen.getByText("omp's own extensions can only be turned on or off in omp's terminal."),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("extension-tab-plugins"));
    fireEvent.click(await screen.findByTestId("extension-item-unlinked-plugin-package"));
    expect(
      screen.getByText(
        "This plugin was not installed from a marketplace, so omp cannot turn it on or off from here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enable plugin" })).toBeNull();
    expect(
      within(screen.getByTestId("extension-inspector")).getByText("Scope").parentElement
        ?.textContent,
    ).toContain("User");
    fireEvent.click(screen.getByTestId("extension-tab-skills"));
    fireEvent.click(await screen.findByTestId("extension-item-skill-one"));
    expect(screen.getByText("Skills cannot be turned on or off from here.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("extension-tab-prompts"));
    fireEvent.click(await screen.findByTestId("extension-item-prompt:native:prompt-one"));
    expect(screen.getByText("Prompts cannot be turned on or off from here.")).toBeTruthy();
  });
});
