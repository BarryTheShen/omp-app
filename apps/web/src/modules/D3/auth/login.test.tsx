import type { CapabilityMap } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthPort, LoginProvider } from "../contract";
import { AUTH_CAPABILITIES } from "../contract";
import { ProviderLoginPanel } from "./login";

afterEach(() => cleanup());

const provider: LoginProvider = {
  id: "provider-a",
  name: "Provider A",
  available: true,
  authenticated: false,
};
const capabilities: CapabilityMap = {
  [AUTH_CAPABILITIES.getLoginProviders]: { state: "available", via: "rpc" },
  [AUTH_CAPABILITIES.login]: { state: "available", via: "rpc" },
};

function auth(overrides: Partial<AuthPort> = {}): AuthPort {
  return {
    capabilities: () => capabilities,
    getLoginProviders: async () => [provider],
    login: async (providerId) => ({ state: "authenticated", providerId }),
    ...overrides,
  };
}

describe("ProviderLoginPanel", () => {
  test("loads providers and reports authenticated login progress without displaying URLs", async () => {
    const login = vi.fn(async (providerId: string) => ({
      state: "authenticated" as const,
      providerId,
    }));
    render(<ProviderLoginPanel auth={auth({ login })} />);

    expect(await screen.findByText("Provider A")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("provider-a", expect.anything()));
    expect(await screen.findByText("Authenticated")).toBeTruthy();
    expect(screen.getByText(/Sign-in opens in a new tab/i)).toBeTruthy();
    expect(screen.queryByText(/https?:\/\//i)).toBeNull();
  });

  test("shows unavailable discovery and empty states", async () => {
    render(
      <ProviderLoginPanel
        auth={auth({
          capabilities: () => ({
            [AUTH_CAPABILITIES.getLoginProviders]: { state: "unavailable", via: "rpc" },
          }),
          getLoginProviders: async () => [],
        })}
      />,
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/discovery is unavailable/i);
    expect(await screen.findByText("No providers are configured.")).toBeTruthy();
  });
});
