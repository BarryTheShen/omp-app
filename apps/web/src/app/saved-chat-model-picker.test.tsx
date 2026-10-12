import type { AppClient } from "@omp-app/client";
import type { UsableModel } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { OverlayHostApi } from "@/overlay";
import { openSavedChatModelPicker } from "./saved-chat-model-picker";

afterEach(() => {
  cleanup();
});

const EMPTY_PICK_LEAD = "Pick a model to open this chat with.";

/** Opens the picker the way the page does, and renders what the overlay would show. The client lists `models`. */
function renderPicker(models: readonly UsableModel[], lead: string = EMPTY_PICK_LEAD) {
  let content: ReactNode = null;
  const overlay = {
    open: (record: { readonly content: (args: { close: () => void }) => ReactNode }) => {
      content = record.content({ close: () => undefined });
    },
  } as unknown as OverlayHostApi;
  const client = {
    port: () => ({ usableModels: () => Promise.resolve({ models }) }),
  } as unknown as AppClient;
  openSavedChatModelPicker({ overlay, client, lead, onPick: () => undefined });
  return render(<div>{content}</div>);
}

describe("openSavedChatModelPicker", () => {
  test("with no model set up, the line says how to set one up with code marks and no literal backticks", async () => {
    const { container } = renderPicker([]);
    await screen.findByText(/omp has no model set up/);
    expect(container.textContent).not.toContain("`");
    expect(screen.getByText("omp", { selector: "code" })).toBeTruthy();
    expect(screen.getByText("/login", { selector: "code" })).toBeTruthy();
  });

  test("the first line is the lead the caller gives, so an open chat's picker can say why it opened", () => {
    const sentence =
      "This chat used fake/gone-model, which is not available any more. Pick another model to open it.";
    const { container } = renderPicker([], sentence);
    expect(container.querySelector("p")?.textContent).toBe(sentence);
  });
});
