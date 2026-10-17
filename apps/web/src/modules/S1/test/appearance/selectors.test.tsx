import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { ShowImagesSelector, ThemeSelector } from "../../appearance/selectors";

afterEach(() => cleanup());

describe("S1.3 terminal-only appearance selectors", () => {
  test("a custom theme name is selected only after confirmation", () => {
    const selected: string[] = [];
    let cancelled = false;
    function Harness() {
      const [value, setValue] = useState("titanium");
      return (
        <ThemeSelector
          settingKey="theme.dark"
          value={value}
          onValueChange={setValue}
          onSelect={(next) => selected.push(next)}
          onCancel={() => {
            cancelled = true;
          }}
        />
      );
    }
    render(<Harness />);

    fireEvent.focus(screen.getByRole("button", { name: "Light" }));
    expect(selected).toEqual([]);
    fireEvent.change(screen.getByLabelText("omp theme name"), {
      target: { value: "custom-dark" },
    });
    expect(selected).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Use this theme name" }));
    expect(selected).toEqual(["custom-dark"]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelled).toBe(true);
  });

  test("image selection is committed only after a button is clicked", () => {
    const selected: boolean[] = [];
    render(
      <ShowImagesSelector
        value
        onSelect={(next) => selected.push(next)}
        onCancel={() => undefined}
      />,
    );

    fireEvent.focus(screen.getByRole("button", { name: "No" }));
    expect(selected).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(selected).toEqual([false]);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(selected).toEqual([false, true]);
  });
});
