import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, ConfigChanged, ConfigEntry } from "@omp-app/contracts";
import { AppFailure, ConfigStore, FolderPath } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsScreen } from "@/app/settings-screen";
import type { ConfigStoreClient } from "../../S1/settings-kit";

afterEach(cleanup);

const HOST_CONFIG_AVAILABLE: CapabilityMap = {
  "host.config": { state: "available", via: "host" },
};

/** A ConfigStore that answers reads and lists from memory. The tests here never save. */
function configStore(entries: readonly ConfigEntry[]): ConfigStoreClient {
  const state = { entries: [...entries], revision: "tab-revision-1" };
  return {
    async read({ key }: { readonly key: string }) {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry) {
        throw new AppFailure({
          code: "not_found",
          message: "The requested setting was not found.",
          retryable: false,
        });
      }
      return entry;
    },
    async list() {
      return { entries: [...state.entries], revision: state.revision };
    },
    async write() {
      throw new AppFailure({
        code: "internal",
        message: "This test does not save settings.",
        retryable: false,
      });
    },
  } as unknown as ConfigStoreClient;
}

function appClient(store: ConfigStoreClient): AppClient {
  const client = {
    port(port: unknown): ConfigStoreClient {
      if (port !== ConfigStore) throw new Error("the Settings screen asked for an unexpected port");
      return store;
    },
    subscribe() {
      return Promise.resolve({
        unsubscribe: async () => undefined,
        onEvent: (_listener: (change: ConfigChanged) => void) => () => undefined,
      });
    },
  };
  return client as unknown as AppClient;
}

const PROJECT = FolderPath.parse("/workspace/context-tab");

describe("the Context tab in the Settings screen", () => {
  test("is listed, with omp's four Context sections, when the host can read settings", async () => {
    render(
      <SettingsScreen
        client={appClient(configStore([]))}
        capabilities={HOST_CONFIG_AVAILABLE}
        folder={null}
        onClose={() => undefined}
        threadId={null}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Context" }));

    expect(await screen.findAllByRole("tab")).toHaveLength(4);
    for (const title of ["General", "Compaction", "Rules (TTSR)", "Experimental"]) {
      expect(screen.getByRole("tab", { name: title })).toBeTruthy();
    }
  });

  test("loads Context after the Settings open paints, before the first Context click", async () => {
    render(
      <SettingsScreen
        client={appClient(configStore([]))}
        capabilities={HOST_CONFIG_AVAILABLE}
        folder={null}
        onClose={() => undefined}
        threadId={null}
      />,
    );

    const contextTabs = await screen.findByRole("tablist", {
      name: "Context sections",
      hidden: true,
    });
    expect(within(contextTabs).getAllByRole("tab", { hidden: true })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Context" }));

    expect(await screen.findByRole("tab", { name: "General" })).toBeTruthy();
    expect(screen.queryByText("Loading context settings…")).toBeNull();
  });

  test("is not listed when the host cannot read settings", async () => {
    render(
      <SettingsScreen
        client={appClient(configStore([]))}
        capabilities={{}}
        folder={null}
        onClose={() => undefined}
        threadId={null}
      />,
    );

    expect(await screen.findByText("Settings unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Context" })).toBeNull();
  });

  test("keeps a staged edit across a tab switch, and the scope buttons stay locked while it is staged", async () => {
    render(
      <SettingsScreen
        client={appClient(configStore([]))}
        capabilities={HOST_CONFIG_AVAILABLE}
        folder={PROJECT}
        onClose={() => undefined}
        threadId={null}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Context" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Compaction" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Auto-Compact" }));
    expect(
      (screen.getByRole("button", { name: "This workspace" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(
      (screen.getByRole("button", { name: "This workspace" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    const panel = screen.getByRole("tabpanel");
    expect(
      (within(panel).getByRole("checkbox", { name: "Auto-Compact" }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});
