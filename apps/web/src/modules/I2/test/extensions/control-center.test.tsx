import { FolderPath } from "@omp-app/contracts";
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
    expect(screen.getByText("No matching providers.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search extensions" }), {
      target: { value: "plugin" },
    });
    expect(screen.getByTestId("extension-item-plugin-one")).toBeTruthy();
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
});
