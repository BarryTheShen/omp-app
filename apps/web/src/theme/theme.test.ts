import { describe, expect, test } from "vitest";
import {
  applyTheme,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("theme preference", () => {
  test("only an explicit Light or Dark is kept; anything else is System", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference(undefined)).toBe("system");
    expect(parseThemePreference("purple")).toBe("system");
  });

  test("System follows the browser; Light and Dark ignore it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("a choice is saved, and System (the default) saves nothing", () => {
    const storage = memoryStorage();
    expect(saveThemePreference("dark", storage)).toBe(true);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference(storage)).toBe("dark");
    saveThemePreference("light", storage);
    expect(readThemePreference(storage)).toBe("light");
    saveThemePreference("system", storage);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readThemePreference(storage)).toBe("system");
  });

  test("a browser that refuses storage reads as System, and says the choice was not saved", () => {
    const refusing = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readThemePreference(refusing)).toBe("system");
    expect(saveThemePreference("dark", refusing)).toBe(false);
  });

  test("applying a theme sets the dark class and the browser's own color scheme, and undoes both", () => {
    const root = document.createElement("html");
    applyTheme(root, "dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
    applyTheme(root, "light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
  });
});
