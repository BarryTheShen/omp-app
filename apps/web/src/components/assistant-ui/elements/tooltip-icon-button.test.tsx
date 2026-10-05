import { render, screen } from "@testing-library/react";
import { PlusIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

import { TooltipIconButton } from "./tooltip-icon-button";

describe("TooltipIconButton", () => {
  it("renders a named icon button from the copied assistant-ui component", () => {
    render(
      <TooltipIconButton tooltip="Add attachment">
        <PlusIcon aria-hidden="true" />
      </TooltipIconButton>,
    );

    expect(screen.getByRole("button", { name: "Add attachment" })).toBeTruthy();
  });
});
