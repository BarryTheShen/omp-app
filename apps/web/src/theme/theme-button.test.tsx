import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setThemePreference, ThemeApplier } from "./store";
import { THEME_STORAGE_KEY } from "./theme";
import { ThemeButton } from "./theme-button";

/** A browser whose dark setting the test can flip: the page must follow it while on System. */
class FakeDarkQuery {
  matches = false;
  readonly #listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void): void {
    this.#listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.#listeners.delete(listener);
  }
  set(dark: boolean): void {
    this.matches = dark;
    for (const listener of [...this.#listeners]) listener();
  }
}

let query: FakeDarkQuery;

beforeEach(() => {
  query = new FakeDarkQuery();
  window.matchMedia = ((media: string) => {
    if (media !== "(prefers-color-scheme: dark)") throw new Error(`unexpected query ${media}`);
    return query as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove("dark");
});

const isDark = (): boolean => document.documentElement.classList.contains("dark");
const radio = (name: string): HTMLElement => screen.getByRole("radio", { name });

/** The app mounts the applier once at the top and the control in the sidebar. */
function renderApp(): void {
  render(
    <>
      <ThemeApplier />
      <ThemeButton />
    </>,
  );
}

describe("the theme control", () => {
  test("is a labelled group of System, Light and Dark, with System chosen by default", () => {
    renderApp();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(
      screen.getAllByRole("radio").map((element) => element.getAttribute("aria-label")),
    ).toEqual(["System", "Light", "Dark"]);
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    expect(radio("Light").getAttribute("aria-checked")).toBe("false");
    expect(isDark()).toBe(false);
  });

  test("Dark darkens the page and is remembered; Light undoes it", () => {
    renderApp();
    fireEvent.click(radio("Dark"));
    expect(isDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Light"));
    expect(isDark()).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  test("a remembered Dark is dark from the first render, and the control shows it", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderApp();
    expect(isDark()).toBe(true);
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
  });

  test("System follows the browser's dark setting live; a fixed choice does not", () => {
    renderApp();
    act(() => query.set(true));
    expect(isDark()).toBe(true);
    act(() => query.set(false));
    expect(isDark()).toBe(false);

    fireEvent.click(radio("Light"));
    act(() => query.set(true));
    expect(isDark()).toBe(false);

    // Back to System: it picks up the browser's current setting at once, and forgets the stored choice.
    fireEvent.click(radio("System"));
    expect(isDark()).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  test("the page keeps its theme when the control is not on screen, and another place can choose too", () => {
    render(<ThemeApplier />);
    // A Settings screen (or any code) sets the choice through the same store.
    act(() => setThemePreference("dark"));
    expect(isDark()).toBe(true);
    act(() => query.set(true));
    act(() => setThemePreference("light"));
    expect(isDark()).toBe(false);
  });

  test("another tab's choice arrives as a storage event and is followed", () => {
    renderApp();
    expect(isDark()).toBe(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }),
      );
    });
    expect(isDark()).toBe(true);
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
  });

  test("one tab stop, and the arrow keys move the choice and the focus", () => {
    renderApp();
    expect(radio("System").getAttribute("tabindex")).toBe("0");
    expect(radio("Light").getAttribute("tabindex")).toBe("-1");
    radio("System").focus();
    fireEvent.keyDown(radio("System"), { key: "ArrowRight" });
    expect(radio("Light").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("Light"));
    fireEvent.keyDown(radio("Light"), { key: "ArrowRight" });
    expect(isDark()).toBe(true);
    // It wraps around: after Dark comes System.
    fireEvent.keyDown(radio("Dark"), { key: "ArrowRight" });
    expect(radio("System").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("System"), { key: "ArrowLeft" });
    expect(radio("Dark").getAttribute("aria-checked")).toBe("true");
  });
});
