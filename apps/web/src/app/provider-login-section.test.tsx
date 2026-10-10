import type { AppClient } from "@omp-app/client";
import { AppFailure, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OverlayHostApi } from "@/overlay";
import {
  openProviderSignIn,
  ProviderLoginSection,
  providerLoginAvailable,
  requireProviderLogin,
} from "./provider-login-section";

afterEach(() => cleanup());

const threadId = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const available = {
  "omp.cmd.get_login_providers": { state: "available" as const, via: "rpc" as const },
};
// Building the sign-in port reads `client.port`; no sign-in call is made in these tests.
const fakeClient = { port: () => ({}) } as unknown as AppClient;

/** An overlay host whose `open` records each dialog it is asked for. */
function fakeOverlay() {
  const open = vi.fn((_options: unknown) => ({ closed: Promise.resolve() }));
  return { open, overlay: { open } as unknown as OverlayHostApi };
}

describe("the provider sign-in section", () => {
  test("with no chat open and no way to start one, it says to open one, and offers no sign-in control", () => {
    render(<ProviderLoginSection capabilities={available} client={fakeClient} threadId={null} />);
    expect(screen.getByText("Open a chat to sign in to a provider.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  test("with no chat open it offers to start one, and choosing it starts a chat", async () => {
    const onStartChat = vi.fn(async () => undefined);
    render(
      <ProviderLoginSection
        capabilities={available}
        client={fakeClient}
        onStartChat={onStartChat}
        threadId={null}
      />,
    );
    expect(screen.queryByText("Open a chat to sign in to a provider.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a chat to sign in" }));
    await waitFor(() => expect(onStartChat).toHaveBeenCalledTimes(1));
  });

  test("a start that fails says why, in the failure's own words", async () => {
    render(
      <ProviderLoginSection
        capabilities={available}
        client={fakeClient}
        onStartChat={async () => {
          throw new AppFailure({
            code: "unavailable",
            message: "Starting a chat needs a selected workspace folder.",
            retryable: false,
          });
        }}
        threadId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start a chat to sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Starting a chat needs a selected workspace folder.",
    );
  });

  test("is offered only when omp can list login providers", () => {
    expect(providerLoginAvailable({})).toBe(false);
    expect(providerLoginAvailable(available)).toBe(true);
  });
});

describe("opening provider sign-in", () => {
  test("from /login or the palette, opens a modal named Provider login that returns focus to the composer", () => {
    const { open, overlay } = fakeOverlay();
    const composer = document.createElement("textarea");
    openProviderSignIn({
      overlay,
      client: fakeClient,
      threadId,
      capabilities: available,
      restoreFocus: composer,
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "modal", label: "Provider login", restoreFocus: composer }),
    );
  });

  test("from a refused key's Sign in, opens the same dialog without a focus target, as it always has", () => {
    const { open, overlay } = fakeOverlay();
    openProviderSignIn({ overlay, client: fakeClient, threadId, capabilities: {} });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "modal", label: "Provider login" }),
    );
    expect(open.mock.calls[0]?.[0]).not.toHaveProperty("restoreFocus");
  });
});

describe("requiring provider login for /login and the palette", () => {
  test("without omp's login command it refuses with a plain reason", () => {
    let thrown: unknown;
    try {
      requireProviderLogin({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      appError: {
        code: "unavailable",
        message: "Provider login is unavailable for this session.",
      },
    });
  });

  test("with omp's login command it lets the dialog open", () => {
    expect(() => requireProviderLogin(available)).not.toThrow();
  });
});
