import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { TextOutput } from "./text-output";

afterEach(() => cleanup());

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

describe("TextOutput", () => {
  test("shows short text whole, with no button", () => {
    render(<TextOutput testId="text" text={lines(16).join("\n")} />);
    expect(screen.getByTestId("text").textContent).toContain("line 16");
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("folds long text to its first lines; the button shows all of it and folds it back", () => {
    render(<TextOutput testId="text" text={lines(200).join("\n")} />);
    const text = () => screen.getByTestId("text").textContent ?? "";
    expect(text()).toContain("line 16");
    expect(text()).not.toContain("line 17");

    fireEvent.click(screen.getByRole("button", { name: "Show all 200 lines" }));
    expect(text()).toContain("line 200");

    fireEvent.click(screen.getByRole("button", { name: "Show fewer lines" }));
    expect(text()).not.toContain("line 17");
  });

  test("keeps the text exactly: blank lines and indentation survive", () => {
    render(<TextOutput testId="text" text={"a\n\n    b"} />);
    expect(screen.getByTestId("text").textContent).toBe("a\n\n    b");
  });
});
