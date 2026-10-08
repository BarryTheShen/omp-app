import type { AppClient } from "@omp-app/client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ProviderLoginSection, providerLoginAvailable } from "./provider-login-section";

afterEach(() => cleanup());

describe("the provider sign-in section", () => {
  test("with no chat open it says to open one, and offers no sign-in control", () => {
    render(
      <ProviderLoginSection
        capabilities={{ "omp.cmd.get_login_providers": { state: "available", via: "rpc" } }}
        client={{} as unknown as AppClient}
        threadId={null}
      />,
    );
    expect(screen.getByText("Open a chat to sign in to a provider.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  test("is offered only when omp can list login providers", () => {
    expect(providerLoginAvailable({})).toBe(false);
    expect(
      providerLoginAvailable({ "omp.cmd.get_login_providers": { state: "available", via: "rpc" } }),
    ).toBe(true);
  });
});
