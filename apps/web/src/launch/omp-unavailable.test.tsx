import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_LOG_FILE, rememberLogFile } from "./log-location";
import { OmpUnavailableScreen } from "./omp-unavailable";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem("omp-app.log-file");
});

describe("OmpUnavailableScreen", () => {
  test("says omp isn't available, why in the server's words, what to do, and where the log is", () => {
    render(<OmpUnavailableScreen reason="omp was not found." />);
    expect(screen.getByRole("heading", { name: "omp isn't available" })).toBeTruthy();
    expect(screen.getByText("omp was not found.")).toBeTruthy();
    // The step that fixes it, and where the app looks for omp.
    const guidance = document.body.textContent ?? "";
    expect(guidance).toContain("omp --version");
    expect(guidance).toContain("~/.bun/bin");
    expect(guidance).toContain("~/.local/bin");
    expect(guidance).toContain("start it again");
    const hint = document.querySelector("[data-log-hint='true']");
    expect(hint?.textContent).toContain("omp-app debug-report");
    expect(hint?.textContent).toContain(DEFAULT_LOG_FILE);
  });

  test("gives the log path the server last reported, and a plain sentence when it gave no reason", () => {
    rememberLogFile("/var/state/omp-app/omp-app.log");
    render(<OmpUnavailableScreen reason={undefined} />);
    expect(screen.getByText("omp app could not use omp.")).toBeTruthy();
    expect(document.querySelector("[data-log-hint='true']")?.textContent).toContain(
      "/var/state/omp-app/omp-app.log",
    );
  });
});
