import { describe, expect, test } from "vitest";
import { guessDevice } from "./device-name";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const LINUX_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const LINUX_WEBKITGTK =
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";

describe("the pairing screen's guess at this device", () => {
  test("an iPhone added to the Home Screen, and the same iPhone in Safari", () => {
    expect(guessDevice({ userAgent: IPHONE, standalone: true, desktopWindow: false })).toEqual({
      name: "iPhone",
      kind: "home-screen-app",
    });
    expect(guessDevice({ userAgent: IPHONE, standalone: false, desktopWindow: false })).toEqual({
      name: "iPhone · Safari",
      kind: "browser",
    });
  });

  test("the desktop window, whatever engine it runs on, and browsers by their own names", () => {
    expect(
      guessDevice({ userAgent: LINUX_WEBKITGTK, standalone: false, desktopWindow: true }),
    ).toEqual({
      name: "Linux",
      kind: "desktop-window",
    });
    expect(
      guessDevice({ userAgent: LINUX_CHROME, standalone: false, desktopWindow: false }).name,
    ).toBe("Linux · Chrome");
    // Edge says Chrome and Safari too: its own name wins.
    expect(
      guessDevice({ userAgent: WINDOWS_EDGE, standalone: false, desktopWindow: false }).name,
    ).toBe("Windows · Edge");
  });
});
