import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppErrorBoundary } from "./error-boundary";

function Thrower({ message }: { readonly message: string }): never {
  throw new Error(message);
}

beforeEach(() => {
  // React logs every caught render error; these tests throw on purpose.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("AppErrorBoundary", () => {
  test("shows its children until one of them fails while rendering", () => {
    render(
      <AppErrorBoundary>
        <p>All good</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("replaces a failed page with a plain message, a Reload button and the technical details", () => {
    const onReload = vi.fn();
    render(
      <AppErrorBoundary onReload={onReload}>
        <Thrower message="usage.percent is too big" />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong in the page");
    expect(screen.getByText(/Your chats are kept by omp/)).toBeTruthy();
    expect(screen.getByText(/usage\.percent is too big/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test("copies the details without the launch token that sits in the address's fragment", async () => {
    window.history.replaceState(null, "", "/app?x=1#token=super-secret-token");
    const copied: string[] = [];
    render(
      <AppErrorBoundary
        copyText={async (text) => {
          copied.push(text);
        }}
      >
        <Thrower message="boom" />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(screen.getByText(/Copied\./)).toBeTruthy());
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("Error: boom");
    expect(copied[0]).toContain("Page: http://localhost:3000/app");
    expect(copied[0]).not.toContain("super-secret-token");
    expect(copied[0]).not.toContain("x=1");
    expect(document.body.textContent).not.toContain("super-secret-token");
  });

  test("says so when the browser refuses the copy, and the details stay on screen", async () => {
    render(
      <AppErrorBoundary
        copyText={async () => {
          throw new Error("denied");
        }}
      >
        <Thrower message="boom" />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(screen.getByText(/Couldn't copy/)).toBeTruthy());
    expect(screen.getByText(/Error: boom/)).toBeTruthy();
  });
});
