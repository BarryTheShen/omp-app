import { describe, expect, test } from "vitest";
import { DEFAULT_LOG_FILE, knownLogFile, rememberLogFile } from "./log-location";

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

describe("the log location the page remembers", () => {
  test("is the app's default until the server has said otherwise, then the server's own answer", () => {
    const storage = memoryStorage();
    expect(knownLogFile(storage)).toBe(DEFAULT_LOG_FILE);
    rememberLogFile("/var/state/omp-app/omp-app.log", storage);
    expect(knownLogFile(storage)).toBe("/var/state/omp-app/omp-app.log");
    // A server running without a log says nothing: the last known place stays.
    rememberLogFile(undefined, storage);
    expect(knownLogFile(storage)).toBe("/var/state/omp-app/omp-app.log");
  });

  test("falls back to the default when the browser refuses storage", () => {
    const refusing = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => rememberLogFile("/x/omp-app.log", refusing)).not.toThrow();
    expect(knownLogFile(refusing)).toBe(DEFAULT_LOG_FILE);
  });
});
