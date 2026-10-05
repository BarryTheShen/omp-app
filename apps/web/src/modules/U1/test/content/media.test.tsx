import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FileFallback, SafeImage } from "../../media";

afterEach(cleanup);

describe("U1.4 media boundaries", () => {
  test("blocks unsafe image sources visibly", () => {
    render(<SafeImage alt="blocked" src="javascript:alert(1)" />);
    expect(screen.getByText("Image unavailable.")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  test("falls back when an allowed image fails to load", () => {
    render(<SafeImage alt="broken" src="https://example.test/image.png" />);
    const image = screen.getByAltText("broken");
    fireEvent.error(image);
    expect(screen.getByText("Image unavailable.")).toBeTruthy();
  });

  test("renders a readable file fallback", () => {
    render(<FileFallback label="Attachment could not be loaded." />);
    expect(screen.getByText("Attachment could not be loaded.")).toBeTruthy();
  });
});
