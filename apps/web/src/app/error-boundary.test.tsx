import type { ClientErrorReport } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rememberLogFile } from "@/launch";
import { setClientErrorSink } from "./client-errors";
import { AppErrorBoundary } from "./error-boundary";

function Thrower({ message }: { readonly message: string }): never {
  throw new Error(message);
}

/** Reports made while no connection exists wait for one; each test starts and ends with none waiting. */
function drainWaitingReports(): void {
  setClientErrorSink(async () => undefined);
  setClientErrorSink(undefined);
}

beforeEach(() => {
  drainWaitingReports();
  // React logs every caught render error; these tests throw on purpose.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  drainWaitingReports();
  window.localStorage.removeItem("omp-app.log-file");
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

  test("says on the screen itself how to save the debug log and where it is, with the server's own path once known", () => {
    rememberLogFile("/var/state/omp-app/omp-app.log");
    render(
      <AppErrorBoundary>
        <Thrower message="boom" />
      </AppErrorBoundary>,
    );
    const hint = document.querySelector("[data-log-hint='true']");
    expect(hint?.textContent).toContain("omp-app debug-report");
    expect(hint?.textContent).toContain("/var/state/omp-app/omp-app.log");
    // It is outside the collapsed technical details: a person sees it without opening anything.
    expect(hint?.closest("details")).toBeNull();
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

  test("sends the failure to the app's debug log with the component stack, and names the log file in the copied details", async () => {
    const sent: ClientErrorReport[] = [];
    setClientErrorSink(async (report) => {
      sent.push(report);
    });
    rememberLogFile("/var/state/omp-app/omp-app.log");
    const copied: string[] = [];
    render(
      <AppErrorBoundary
        copyText={async (text) => {
          copied.push(text);
        }}
      >
        <Thrower message="usage.percent is too big" />
      </AppErrorBoundary>,
    );
    const renderReports = sent.filter((report) => report.kind === "render");
    expect(renderReports).toHaveLength(1);
    expect(renderReports[0]?.message).toBe("Error: usage.percent is too big");
    expect(renderReports[0]?.stack).toContain("Component stack:");
    expect(renderReports[0]?.stack).toContain("Thrower");
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toContain("omp app log: /var/state/omp-app/omp-app.log");
    expect(copied[0]).toContain('run "omp-app debug-report"');
  });
});
