import type { AppClient } from "@omp-app/client";
import { ThreadId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OverlayHostApi } from "@/overlay";
import {
  openProviderLogin,
  ProviderLoginSection,
  providerLoginAvailable,
} from "./provider-login-section";

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

describe("opening the provider login page over a chat", () => {
  const threadId = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
  const client = { port: () => ({}) } as unknown as AppClient;
  const available = {
    "omp.cmd.get_login_providers": { state: "available" as const, via: "rpc" as const },
  };

  function fakeOverlay() {
    const open = vi.fn(() => ({ closed: Promise.resolve() }));
    return { open, overlay: { open } as unknown as OverlayHostApi };
  }

  test("opens a modal named Provider login, returning focus to the element it is given", () => {
    const { open, overlay } = fakeOverlay();
    const composer = document.createElement("textarea");
    openProviderLogin({
      overlay,
      client,
      threadId,
      capabilities: available,
      restoreFocus: composer,
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "modal", label: "Provider login", restoreFocus: composer }),
    );
  });

  test("without omp's login command it refuses with a plain reason, and opens nothing", () => {
    const { open, overlay } = fakeOverlay();
    let thrown: unknown;
    try {
      openProviderLogin({ overlay, client, threadId, capabilities: {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      appError: {
        code: "unavailable",
        message: "Provider login is unavailable for this session.",
      },
    });
    expect(open).not.toHaveBeenCalled();
  });
});
