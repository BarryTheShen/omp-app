import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SLASH_TIP_PLACEHOLDER, useSlashTip } from "./tip";

function TipHarness() {
  const tip = useSlashTip();
  return createElement(
    "div",
    null,
    createElement(
      "output",
      { "data-testid": "placeholder" },
      tip.placeholder ?? "Send a message...",
    ),
    createElement("button", { type: "button", onClick: tip.recordSlashSend }, "Record slash send"),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("useSlashTip", () => {
  test("shows the tip until three successful slash sends", () => {
    render(createElement(TipHarness));
    const placeholder = screen.getByTestId("placeholder");
    const record = screen.getByRole("button", { name: "Record slash send" });

    expect(placeholder.textContent).toBe(SLASH_TIP_PLACEHOLDER);
    fireEvent.click(record);
    expect(placeholder.textContent).toBe(SLASH_TIP_PLACEHOLDER);
    expect(window.localStorage.getItem("omp-app.slash-sends")).toBe("1");
    fireEvent.click(record);
    expect(placeholder.textContent).toBe(SLASH_TIP_PLACEHOLDER);
    expect(window.localStorage.getItem("omp-app.slash-sends")).toBe("2");
    fireEvent.click(record);
    expect(placeholder.textContent).toBe("Send a message...");
    expect(window.localStorage.getItem("omp-app.slash-sends")).toBe("3");
  });

  test("reads the saved count and keeps the tip hidden after reloads", () => {
    window.localStorage.setItem("omp-app.slash-sends", "3");
    render(createElement(TipHarness));

    expect(screen.getByTestId("placeholder").textContent).toBe("Send a message...");
  });

  test("invalid saved counts are treated as zero", () => {
    window.localStorage.setItem("omp-app.slash-sends", "not-a-count");
    render(createElement(TipHarness));

    expect(screen.getByTestId("placeholder").textContent).toBe(SLASH_TIP_PLACEHOLDER);
  });

  test.each(["read", "write"] as const)(
    "a storage %s failure never hides or throws from the tip",
    (operation) => {
      const method = operation === "read" ? "getItem" : "setItem";
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => render(createElement(TipHarness))).not.toThrow();
      expect(screen.getByTestId("placeholder").textContent).toBe(SLASH_TIP_PLACEHOLDER);
      fireEvent.click(screen.getByRole("button", { name: "Record slash send" }));
      expect(screen.getByTestId("placeholder").textContent).toBe(SLASH_TIP_PLACEHOLDER);
    },
  );

  test("missing local storage is treated as an unread count", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(() => render(createElement(TipHarness))).not.toThrow();
    expect(screen.getByTestId("placeholder").textContent).toBe(SLASH_TIP_PLACEHOLDER);
  });
});
