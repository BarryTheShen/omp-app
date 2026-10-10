import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ConnectionBanner } from "./connection-banner";

afterEach(cleanup);

describe("ConnectionBanner", () => {
  test("says the app is reconnecting, with no instructions, while the outage is short", () => {
    render(<ConnectionBanner />);
    expect(screen.getByRole("status").textContent).toBe(
      "Connection lost. Reconnecting to omp-app…",
    );
    expect(document.querySelector("[data-log-hint]")).toBeNull();
  });

  test("after a long outage, says what to do and where the app's log is", () => {
    render(<ConnectionBanner unreachable />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(
      "omp-app is not answering. Check that it is still running, then reload this page.",
    );
    expect(status.textContent).not.toContain("Connection lost");
    expect(document.querySelector("[data-log-hint='true']")?.textContent).toContain("omp-app logs");
  });
});
