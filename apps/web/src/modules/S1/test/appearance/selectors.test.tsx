import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { APP_COMPOSER_PREVIEW_NOTE, APP_THEME_PREVIEW_NOTE } from "../../appearance/descriptors";
import { composerPreviewNote, previewOmpTheme } from "../../appearance/preview";
import { ShowImagesSelector, ThemeSelector } from "../../appearance/selectors";

afterEach(() => cleanup());

describe("S1.3 browser-owned appearance previews", () => {
  test("previews only bundled theme palettes and explains unbundled names", () => {
    expect(previewOmpTheme("theme.dark", "titanium")).toEqual({ palette: "dark" });
    expect(previewOmpTheme("theme.light", "light")).toEqual({ palette: "light" });
    expect(previewOmpTheme("theme.dark", "custom-dark")).toEqual({
      palette: "dark",
      note: APP_THEME_PREVIEW_NOTE,
    });
    expect(previewOmpTheme("theme.light", "custom-light")).toEqual({
      palette: "light",
      note: APP_THEME_PREVIEW_NOTE,
    });
    expect(composerPreviewNote("band")).toBeUndefined();
    expect(composerPreviewNote("box")).toBeUndefined();
    expect(composerPreviewNote("extension-shape")).toBe(APP_COMPOSER_PREVIEW_NOTE);
  });

  test("controlled theme selection previews a custom name and sends selection callbacks", () => {
    const previews: string[] = [];
    const selected: string[] = [];
    let cancelled = false;
    function Harness() {
      const [value, setValue] = useState("titanium");
      return (
        <ThemeSelector
          settingKey="theme.dark"
          value={value}
          onValueChange={setValue}
          onPreview={(next) => previews.push(next)}
          onSelect={(next) => selected.push(next)}
          onCancel={() => {
            cancelled = true;
          }}
        />
      );
    }
    render(<Harness />);

    fireEvent.focus(screen.getByRole("button", { name: "Light" }));
    expect(previews).toContain("light");
    fireEvent.change(screen.getByLabelText("OMP theme name"), {
      target: { value: "custom-dark" },
    });
    expect(previews).toContain("custom-dark");
    fireEvent.click(screen.getByRole("button", { name: "Use this theme name" }));
    expect(selected).toEqual(["custom-dark"]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelled).toBe(true);
  });

  test("controlled image selection previews Yes/No and selects the ConfigStore value", () => {
    const previews: boolean[] = [];
    const selected: boolean[] = [];
    render(
      <ShowImagesSelector
        value
        onPreview={(next) => previews.push(next)}
        onSelect={(next) => selected.push(next)}
        onCancel={() => undefined}
      />,
    );

    fireEvent.focus(screen.getByRole("button", { name: "No" }));
    expect(previews).toEqual([false]);
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(selected).toEqual([false]);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(selected).toEqual([false, true]);
  });
});
