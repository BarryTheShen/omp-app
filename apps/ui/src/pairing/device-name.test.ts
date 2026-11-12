import { DeviceName } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { guessDevice } from "./device-name";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const LINUX_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0";
const LINUX_WEBKITGTK =
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";

const page = { standalone: false, desktopWindow: false } as const;

describe("the pairing screen's guess at this device", () => {
  test("a Home Screen app and the same iPhone in Safari, named for the computer and, without it, the system", () => {
    expect(
      guessDevice({ userAgent: IPHONE, standalone: true, desktopWindow: false }, "my-phone"),
    ).toEqual({ name: "Home Screen app on my-phone", kind: "home-screen-app" });
    expect(
      guessDevice({ userAgent: IPHONE, standalone: true, desktopWindow: false }, null),
    ).toEqual({ name: "Home Screen app on iPhone", kind: "home-screen-app" });
    expect(guessDevice({ userAgent: IPHONE, ...page }, "my-phone")).toEqual({
      name: "Safari on my-phone",
      kind: "browser",
    });
    expect(guessDevice({ userAgent: IPHONE, ...page }, null)).toEqual({
      name: "Safari on iPhone",
      kind: "browser",
    });
  });

  test("the desktop window, whatever engine it runs on", () => {
    const desktop = { userAgent: LINUX_WEBKITGTK, standalone: false, desktopWindow: true };
    expect(guessDevice(desktop, "my-laptop")).toEqual({
      name: "Desktop app on my-laptop",
      kind: "desktop-window",
    });
    expect(guessDevice(desktop, null)).toEqual({
      name: "Desktop app on Linux",
      kind: "desktop-window",
    });
  });

  test("browsers by their own names; Edge says Chrome and Safari too, and its own name wins", () => {
    expect(guessDevice({ userAgent: LINUX_CHROME, ...page }, "my-laptop").name).toBe(
      "Chrome on my-laptop",
    );
    expect(guessDevice({ userAgent: LINUX_FIREFOX, ...page }, "my-laptop").name).toBe(
      "Firefox on my-laptop",
    );
    expect(guessDevice({ userAgent: LINUX_FIREFOX, ...page }, null).name).toBe("Firefox on Linux");
    expect(guessDevice({ userAgent: WINDOWS_EDGE, ...page }, null).name).toBe("Edge on Windows");
    expect(guessDevice({ userAgent: "unknown agent", ...page }, null).name).toBe(
      "browser on This computer",
    );
  });

  test("a panel in another app's frame is named for its host: Zen's sidebar, VS Code, any other host", () => {
    const panel = (host: string | null, machine: string | null) =>
      guessDevice({ userAgent: LINUX_FIREFOX, ...page, host }, machine);
    expect(panel("zen", "my-laptop")).toEqual({
      name: "Zen sidebar on my-laptop",
      kind: "browser",
    });
    expect(panel("zen", null).name).toBe("Zen sidebar on Linux");
    expect(panel("vscode", "my-laptop")).toEqual({ name: "VS Code on my-laptop", kind: "browser" });
    expect(panel("vscode", null).name).toBe("VS Code on Linux");
    expect(panel("siyuan", "my-laptop").name).toBe("siyuan panel on my-laptop");
    // A page with no host, or one that has not heard from it yet, is a browser tab.
    expect(panel(null, "my-laptop").name).toBe("Firefox on my-laptop");
    // The desktop window is named for what it is, whatever the host says.
    expect(
      guessDevice(
        { userAgent: LINUX_WEBKITGTK, standalone: false, desktopWindow: true, host: "zen" },
        null,
      ).name,
    ).toBe("Desktop app on Linux");
  });

  test("a name never goes over what the app takes: the computer's name is cut short", () => {
    const longest = "m".repeat(63);
    const guesses = [
      guessDevice({ userAgent: LINUX_CHROME, ...page, host: "a".repeat(32) }, longest),
      guessDevice({ userAgent: IPHONE, standalone: true, desktopWindow: false }, longest),
      guessDevice({ userAgent: LINUX_CHROME, standalone: false, desktopWindow: true }, longest),
      guessDevice({ userAgent: LINUX_CHROME, ...page }, longest),
    ];
    for (const guess of guesses) {
      expect(guess.name.length).toBeLessThanOrEqual(60);
      expect(DeviceName.safeParse(guess.name).success).toBe(true);
    }
    expect(guesses[1]?.name).toBe(`Home Screen app on ${"m".repeat(41)}`);
  });
});
