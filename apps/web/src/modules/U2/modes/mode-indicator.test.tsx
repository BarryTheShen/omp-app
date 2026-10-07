import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessage,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { CapabilityMap } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type PropsWithChildren, useMemo } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { ModeIndicator } from "./mode-indicator";

const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.bash": { state: "available", via: "rpc" },
  "upstream.python-mode": {
    state: "unavailable",
    via: "upstream",
    detail: "Python mode is not released",
  },
};

function TextProbe() {
  const text = useAuiState((state) => state.composer.text);
  return <span data-testid="composer-text">{text}</span>;
}

function Provider({ children }: PropsWithChildren) {
  const runtime = useExternalStoreRuntime({
    messages: useMemo<readonly ThreadMessage[]>(() => [], []),
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => cleanup());

describe("U2.6 ModeIndicator", () => {
  test("clicking Bash adds ! and Prompt removes the prefix", async () => {
    render(
      <Provider>
        <ComposerPrimitive.Input aria-label="Mode input" />
        <ModeIndicator capabilities={capabilities} />
        <TextProbe />
      </Provider>,
    );
    const input = screen.getByRole("textbox", { name: "Mode input" });
    fireEvent.change(input, { target: { value: "ls" } });
    expect(screen.getByTestId("composer-text").textContent).toBe("ls");
    fireEvent.click(screen.getByRole("button", { name: "Bash" }));
    await waitFor(() => expect(screen.getByTestId("composer-text").textContent).toBe("!ls"));
    expect(screen.getByRole("button", { name: "Bash" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    await waitFor(() => expect(screen.getByTestId("composer-text").textContent).toBe("ls"));
    expect(screen.getByRole("button", { name: "Prompt" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
  test("keeps the unavailable Python reason in a tooltip", () => {
    render(
      <Provider>
        <ComposerPrimitive.Input aria-label="Mode input" />
        <ModeIndicator capabilities={capabilities} />
      </Provider>,
    );

    const python = screen.getByRole("button", { name: "Python" });
    expect(python.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTitle("Python mode is not released")).toBeTruthy();
    expect(screen.queryByText("Python mode is not released", { exact: true })).toBeNull();
    expect(screen.getByRole("group", { name: "Input mode" })).toBeTruthy();
  });

  test("typing ! immediately highlights Bash and deleting it returns Prompt", async () => {
    render(
      <Provider>
        <ComposerPrimitive.Input aria-label="Mode input" />
        <ModeIndicator capabilities={capabilities} />
      </Provider>,
    );
    const input = screen.getByRole("textbox", { name: "Mode input" });
    fireEvent.change(input, { target: { value: "!" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Bash" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Prompt" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });
});
