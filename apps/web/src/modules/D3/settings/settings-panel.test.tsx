import type { AppClient } from "@omp-app/client";
import type {
  ConfigEntry,
  ConfigListResult,
  ConfigWriteArgs,
  ConfigWriteResult,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProviderSettingsController } from "./controller";
import { ProviderSettingsPanel } from "./settings-panel";

afterEach(() => cleanup());

function fakeClient(
  mode:
    | "ok"
    | "load-failure"
    | "save-then-reload-failure"
    | "save-failure"
    | "conflict"
    | "save-then-conflict"
    | "save-then-success"
    | "reload-failure" = "ok",
): {
  client: AppClient;
  list: ReturnType<typeof vi.fn>;
} {
  let entries: ConfigEntry[] = [
    {
      key: "providers.fireworksTier",
      secret: false,
      value: "standard",
      source: "global",
      overrides: [],
    },
  ];
  let writes = 0;
  const list = vi.fn(async (): Promise<ConfigListResult> => {
    if (
      mode === "load-failure" ||
      ((mode === "reload-failure" || mode === "save-then-reload-failure") && writes > 0)
    ) {
      throw new AppFailure({
        code: "permission",
        message: "The settings could not be read here.",
        retryable: true,
      });
    }
    return {
      entries,
      revision: mode.includes("conflict") ? `revision-${writes + 2}` : `revision-${writes + 1}`,
    };
  });
  const write = vi.fn(async (args: ConfigWriteArgs): Promise<ConfigWriteResult> => {
    writes += 1;
    if (
      mode === "save-failure" ||
      ((mode === "save-then-conflict" ||
        mode === "save-then-success" ||
        mode === "save-then-reload-failure") &&
        writes === 1)
    ) {
      throw new AppFailure({
        code: "permission",
        message: "The settings could not be saved here.",
        retryable: true,
      });
    }
    if (mode === "conflict" || (mode === "save-then-conflict" && writes > 1)) {
      entries = [{ ...entries[0], value: "off" } as ConfigEntry];
      throw new AppFailure({
        code: "conflict",
        message: "Another writer changed this setting.",
        retryable: true,
      });
    }
    const entry = {
      ...args.value,
      key: args.key,
      source: "global" as const,
      overrides: [],
    } as ConfigEntry;
    entries = [entry];
    return {
      key: args.key,
      layer: "global",
      folder: null,
      revision: `revision-${writes + 1}`,
      previousRevision: `revision-${writes}`,
      entry,
    };
  });
  const port = () => ({
    list,
    read: vi.fn(),
    write,
  });
  return {
    client: {
      port,
      subscribe: vi.fn(async () => ({ unsubscribe: async () => undefined })),
    } as unknown as AppClient,
    list,
  };
}

describe("ProviderSettingsPanel", () => {
  test("loads a source-aware provider section and lists all section tabs", async () => {
    const fake = fakeClient();
    const controller = createProviderSettingsController({
      client: fake.client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    render(
      <StrictMode>
        <ProviderSettingsPanel controller={controller} />
      </StrictMode>,
    );
    expect(await screen.findByText("Fireworks tier")).toBeTruthy();
    const fireworksTab = screen.getByRole("tab", { name: "Fireworks" });
    fireEvent.keyDown(fireworksTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Tiny model" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Tiny model" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Privacy" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Privacy" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Fireworks" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Fireworks" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Privacy" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Privacy" }));
    expect(screen.getByRole("tab", { name: "Fireworks" }).getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Privacy" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Fireworks" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    controller.runtime("D3.providerFireworks").stage("providers.fireworksTier", {
      secret: false,
      value: "priority",
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Protocol" }));
    expect(
      await screen.findByText("Save or cancel these changes before switching sections."),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Protocol" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Timeouts" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Privacy" })).toBeTruthy();
    expect(screen.getByText(/Source:/)).toBeTruthy();
    controller.dispose();
  });

  test("shows a truthful capability reason without trying to load config", async () => {
    const fake = fakeClient();
    const controller = createProviderSettingsController({
      client: fake.client,
      capabilities: {
        "host.config": {
          state: "unavailable",
          via: "host",
          detail: "omp cannot edit provider settings here.",
        },
      },
      folder: null,
    });
    render(<ProviderSettingsPanel controller={controller} />);
    expect(await screen.findByText("omp cannot edit provider settings here.")).toBeTruthy();
    expect(screen.queryByText("Loading provider settings…")).toBeNull();
    expect(screen.queryByText("Fireworks tier")).toBeNull();
    expect(fake.list).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("shows a failed load in words and gives the person Retry", async () => {
    const fake = fakeClient("load-failure");
    const controller = createProviderSettingsController({
      client: fake.client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    render(<ProviderSettingsPanel controller={controller} />);
    expect(await screen.findByText("The settings could not be read here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    controller.dispose();
  });

  test("shows failed saves and keeps the unsaved setting", async () => {
    const fake = fakeClient("save-failure");
    const controller = createProviderSettingsController({
      client: fake.client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const runtime = controller.runtime("D3.providerFireworks");
    await runtime.read();
    runtime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The settings could not be saved here.")).toBeTruthy();
    expect(screen.getByText(/Not saved:/)).toBeTruthy();
    controller.dispose();
  });

  test("shows conflicts and supports Keep my edits and Reload latest", async () => {
    const fake = fakeClient("conflict");
    const controller = createProviderSettingsController({
      client: fake.client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const runtime = controller.runtime("D3.providerFireworks");
    await runtime.read();
    runtime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings changed elsewhere")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await waitFor(() => expect(screen.queryByText("Settings changed elsewhere")).toBeNull());
    controller.dispose();
    cleanup();
    const reloadController = createProviderSettingsController({
      client: fakeClient("conflict").client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const reloadRuntime = reloadController.runtime("D3.providerFireworks");
    await reloadRuntime.read();
    reloadRuntime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={reloadController} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings changed elsewhere")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() => expect(screen.queryByText("Settings changed elsewhere")).toBeNull());
    reloadController.dispose();
  });
  test("clears a prior save error for each conflict choice", async () => {
    const first = createProviderSettingsController({
      client: fakeClient("save-then-conflict").client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const firstRuntime = first.runtime("D3.providerFireworks");
    await firstRuntime.read();
    firstRuntime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={first} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The settings could not be saved here.")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }).getAttribute("disabled"),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings changed elsewhere")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await waitFor(() =>
      expect(screen.queryByText("Provider settings could not be saved")).toBeNull(),
    );
    first.dispose();
    cleanup();

    const second = createProviderSettingsController({
      client: fakeClient("save-then-conflict").client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const secondRuntime = second.runtime("D3.providerFireworks");
    await secondRuntime.read();
    secondRuntime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={second} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The settings could not be saved here.")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }).getAttribute("disabled"),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings changed elsewhere")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() =>
      expect(screen.queryByText("Provider settings could not be saved")).toBeNull(),
    );
    second.dispose();
  });

  test("clears a failed save after a successful second Save", async () => {
    const controller = createProviderSettingsController({
      client: fakeClient("save-then-success").client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const runtime = controller.runtime("D3.providerFireworks");
    await runtime.read();
    runtime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The settings could not be saved here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.queryByText("The settings could not be saved here.")).toBeNull(),
    );
    controller.dispose();
  });

  test("keeps a failed reload's loaded section and unsaved edit visible", async () => {
    const controller = createProviderSettingsController({
      client: fakeClient("save-then-reload-failure").client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const runtime = controller.runtime("D3.providerFireworks");
    await runtime.read();
    runtime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The settings could not be read here.")).toBeTruthy();
    expect(screen.getByText("Not saved: Fireworks tier.")).toBeTruthy();
    expect(screen.getByText("Fireworks tier")).toBeTruthy();
    controller.dispose();
  });

  test("does not carry a failed save after canceling and changing sections", async () => {
    const controller = createProviderSettingsController({
      client: fakeClient("save-failure").client,
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const runtime = controller.runtime("D3.providerFireworks");
    await runtime.read();
    runtime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    render(<ProviderSettingsPanel controller={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The settings could not be saved here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("tab", { name: "Protocol" }));
    await screen.findByText("Kimi API format");
    fireEvent.click(screen.getByRole("tab", { name: "Fireworks" }));
    await screen.findByText("Fireworks tier");
    expect(screen.queryByText("Provider settings could not be saved")).toBeNull();
    controller.dispose();
  });
});
