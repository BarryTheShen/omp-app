import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_REST_MS, pickTheme, previewTheme, setThemeChoice } from "./theme";

/** Every theme the page was drawn in, in order: each one is the whole page styled again. */
const drawn: string[] = [];
const dataset = {};
Object.defineProperty(dataset, "theme", {
  get: () => drawn.at(-1),
  set: (id: string) => drawn.push(id),
});
const root = { dataset, classList: { toggle: () => true } };

const [a, b, c] = ["catppuccin-mocha", "tokyo-night-storm", "catppuccin-latte"] as const;

describe("a theme preview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { documentElement: root });
    setThemeChoice("tern-dark");
    drawn.length = 0;
  });

  afterEach(() => {
    previewTheme(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("draws the page once for a sweep, in the theme it stops on", () => {
    previewTheme(a);
    vi.advanceTimersByTime(40);
    previewTheme(b);
    vi.advanceTimersByTime(40);
    previewTheme(c);
    vi.advanceTimersByTime(PREVIEW_REST_MS - 1);
    expect(drawn).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(drawn).toEqual([c]);
  });

  it("keeps the theme shown while the next one waits, with no kept theme between", () => {
    previewTheme(a);
    vi.advanceTimersByTime(PREVIEW_REST_MS);
    previewTheme(b);
    vi.advanceTimersByTime(PREVIEW_REST_MS - 1);
    expect(drawn).toEqual([a]);
    vi.advanceTimersByTime(1);
    expect(drawn).toEqual([a, b]);
  });

  it("ends at once, and a theme still waiting never shows", () => {
    previewTheme(a);
    vi.advanceTimersByTime(PREVIEW_REST_MS);
    previewTheme(b);
    previewTheme(null);
    expect(drawn).toEqual([a, "tern-dark"]);
    vi.advanceTimersByTime(PREVIEW_REST_MS * 2);
    expect(drawn).toEqual([a, "tern-dark"]);
  });

  it("gives way to a theme picked while it waits", () => {
    previewTheme(a);
    pickTheme(b);
    vi.advanceTimersByTime(PREVIEW_REST_MS * 2);
    expect(drawn).toEqual([b]);
  });
});
