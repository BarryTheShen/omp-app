import type { AppClient } from "@omp-app/client";
import type { ConfigListResult } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProviderSettingsController } from "../settings/controller";
import { ProviderSettingsPanel } from "../settings/settings-panel";

afterEach(() => cleanup());

function fakeClient(): AppClient {
  const port = () => ({
    list: vi.fn(async (): Promise<ConfigListResult> => ({ entries: [], revision: "revision-1" })),
    read: vi.fn(),
    write: vi.fn(),
  });
  return {
    port,
    subscribe: vi.fn(async () => ({ unsubscribe: async () => undefined })),
  } as unknown as AppClient;
}

describe("D3 accessibility gate", () => {
  test("renders every provider setting control with a reachable label and keyboard tabs", async () => {
    const controller = createProviderSettingsController({
      client: fakeClient(),
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: "/workspace/project" as never,
    });
    render(
      <StrictMode>
        <ProviderSettingsPanel controller={controller} />
      </StrictMode>,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);

    expect(await screen.findByRole("combobox", { name: "Fireworks tier" })).toBeTruthy();
    for (const section of ["Tiny model", "Protocol", "Timeouts", "Privacy"]) {
      fireEvent.click(screen.getByRole("tab", { name: section }));
      expect(screen.getByRole("tab", { name: section }).getAttribute("aria-selected")).toBe("true");
      await screen.findByRole("tabpanel");
    }
    fireEvent.click(screen.getByRole("tab", { name: "Tiny model" }));
    expect(await screen.findByRole("combobox", { name: "Tiny model device" })).toBeTruthy();
    expect(await screen.findByRole("combobox", { name: "Tiny model precision" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Protocol" }));
    for (const label of [
      "Kimi API format",
      "OpenAI WebSockets",
      "OpenRouter routing",
      "Prompt cache retention",
      "Cache warming",
      "OpenAI live steering",
      "Append-only context",
    ]) {
      const role = label === "OpenAI live steering" ? "checkbox" : "combobox";
      expect(await screen.findByRole(role, { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Timeouts" }));
    expect(
      await screen.findByRole("spinbutton", { name: "Stream first event timeout" }),
    ).toBeTruthy();
    expect(await screen.findByRole("spinbutton", { name: "Stream idle timeout" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    expect(await screen.findByRole("checkbox", { name: "Hide secrets" })).toBeTruthy();
    expect(await screen.findByRole("checkbox", { name: "OTLP telemetry export" })).toBeTruthy();
    controller.dispose();
  });
});
