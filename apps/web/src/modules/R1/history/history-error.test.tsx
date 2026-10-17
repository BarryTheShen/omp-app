import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HistoryLoadFailureNotice } from "./history-error";

afterEach(cleanup);

describe("HistoryLoadFailureNotice", () => {
  test("explains the missing history and retries the read", () => {
    const onRetry = vi.fn(async () => undefined);
    render(
      <HistoryLoadFailureNotice
        error={{ code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Earlier messages could not be loaded.",
    );
    expect(screen.getByRole("alert").textContent).toContain("omp exited (signal SIGKILL)");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
