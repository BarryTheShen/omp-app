import type { ThreadId, UiRequestId } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AskDialogRequest, DialogRequest, DialogResponse } from "../contract";
import { toWireExtensionUiResponse } from "../contract/responses";
import type { DialogRenderContext } from "../host";
import { AskResultCard } from "./ask-result";
import { renderDialogRequest } from "./renderer";

afterEach(cleanup);

const threadId = "dialog-test-thread" as ThreadId;

function renderRequest(request: DialogRequest, deadlineAt?: number) {
  const answers: DialogResponse[] = [];
  let cancellations = 0;
  const context: DialogRenderContext = {
    request,
    threadId,
    deadlineAt,
    signal: new AbortController().signal,
    answer: async (response) => {
      answers.push(response);
    },
    cancel: async () => {
      cancellations += 1;
    },
  };
  render(renderDialogRequest(request, context));
  return {
    answers,
    get cancellations() {
      return cancellations;
    },
  };
}

/** The mark an option shows: "true" while it is ticked or chosen, "false" otherwise. */
function markOf(option: HTMLElement): string | null {
  return option.querySelector("[data-selected]")?.getAttribute("data-selected") ?? null;
}

describe("select dialog", () => {
  test("filters long lists, supports keyboard selection and emits exact labels", async () => {
    const request: DialogRequest = {
      kind: "select",
      id: "select-1" as UiRequestId,
      title: "Choose a color",
      options: ["Azure", "Beryl", "Crimson", "Delta", "Echo", "Fjord", "Gold", "Hazel"],
      optionDetails: [
        { description: "blue" },
        { description: "green" },
        { description: "red" },
        { description: "gray" },
        { description: "orange" },
        { description: "teal" },
        { description: "yellow" },
        { description: "brown" },
      ],
    };
    const result = renderRequest(request);
    const filter = screen.getByRole("textbox", { name: "Filter options" });
    filter.focus();
    fireEvent.change(filter, { target: { value: "green" } });
    expect(screen.queryByRole("option", { name: /Azure/ })).toBeNull();
    const beryl = screen.getByRole("option", { name: /Beryl/ });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() => expect(beryl.getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(result.answers).toEqual([{ kind: "select", value: "Beryl" }]);
    const selectedResponse = result.answers[0];
    if (!selectedResponse) throw new Error("The selected response was not recorded.");
    expect(
      toWireExtensionUiResponse(request.id, { outcome: "answered", response: selectedResponse }),
    ).toEqual({
      type: "extension_ui_response",
      id: request.id,
      value: "Beryl",
    });
  });

  test("hides the filter for short lists and selects by first letter", () => {
    const result = renderRequest({
      kind: "select",
      id: "select-short" as UiRequestId,
      title: "Choose",
      options: ["Alpha", "Beta", "Gamma"],
    });
    expect(screen.queryByRole("textbox", { name: "Filter options" })).toBeNull();
    const listbox = screen.getByRole("listbox", { name: "Choose" });
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "b" });
    expect(screen.getByRole("option", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(result.answers).toEqual([{ kind: "select", value: "Beta" }]);
  });

  test("cancel has no value and does not answer", () => {
    const result = renderRequest({
      kind: "select",
      id: "select-cancel" as UiRequestId,
      title: "Choose",
      options: ["A"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(result.answers).toEqual([]);
    expect(result.cancellations).toBe(1);
  });
});

describe("confirm dialog", () => {
  test("focuses deny by default for the destructive-safe confirm", async () => {
    const result = renderRequest({
      kind: "confirm",
      id: "confirm-1" as UiRequestId,
      title: "Delete workspace?",
      message: "This cannot be undone.",
    });
    const deny = screen.getByRole("button", { name: "Deny" });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    expect(deny.getAttribute("data-confirmation-default")).toBe("deny");
    fireEvent.click(deny);
    expect(result.answers).toEqual([{ kind: "confirm", confirmed: false }]);
  });

  test("renders untrusted text as text, never executable markup", () => {
    renderRequest({
      kind: "confirm",
      id: "confirm-xss" as UiRequestId,
      title: "<img src=x onerror=alert(1)>",
      message: "<a href='javascript:alert(1)'>unsafe</a>",
    });
    expect(screen.getByRole("heading").textContent).toContain("<img");
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
  });
});

describe("input and editor dialogs", () => {
  test("validates blank input and masks secret input without echoing it", () => {
    const request = {
      kind: "input" as const,
      id: "input-secret" as UiRequestId,
      title: "API key",
      placeholder: "Paste key",
      secret: true,
    } as DialogRequest;
    const result = renderRequest(request);
    const input = screen.getByLabelText("API key");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter a value");
    fireEvent.change(input, { target: { value: "private-value" } });
    expect(screen.queryByText("private-value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(result.answers).toEqual([{ kind: "input", value: "private-value" }]);
  });

  test("editor submits multiline text on Ctrl/Cmd+Enter", () => {
    const result = renderRequest({
      kind: "editor",
      id: "editor-1" as UiRequestId,
      title: "Notes",
      prefill: "one",
    });
    const editor = screen.getByRole("textbox", { name: "Notes" });
    fireEvent.change(editor, { target: { value: "one\ntwo" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(result.answers).toEqual([{ kind: "editor", value: "one\ntwo" }]);
  });

  test("a read-only editor offers one Done button, no Save or save hint, and text that cannot be changed", () => {
    const result = renderRequest({
      kind: "editor",
      id: "editor-2" as UiRequestId,
      title: 'Copy "Command 1" by hand',
      prefill: "echo inside",
      readOnly: true,
    });
    const editor = screen.getByRole("textbox", { name: 'Copy "Command 1" by hand' });
    expect(editor.hasAttribute("readonly")).toBe(true);
    expect(editor).toHaveProperty("value", "echo inside");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByText(/saves/)).toBeNull();
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(result.answers).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(result.answers).toEqual([{ kind: "editor", value: "echo inside" }]);
  });

  test("an editor that is not read-only keeps its Save button and save hint", () => {
    renderRequest({ kind: "editor", id: "editor-3" as UiRequestId, title: "Notes", prefill: "" });
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByText("Ctrl/Cmd+Enter saves.")).toBeTruthy();
  });
});

describe("rich Ask dialog and result card", () => {
  const askRequest: AskDialogRequest = {
    kind: "ask",
    id: "ask-1" as UiRequestId,
    questions: [
      {
        id: "q1",
        question: "Pick a mode",
        header: "Mode",
        options: [
          { label: "Fast", description: "Lower latency" },
          { label: "Thorough", description: "More analysis" },
        ],
      },
    ],
  };

  test("supports option descriptions, Other free text, review and exact ask answers", () => {
    const result = renderRequest(askRequest);
    expect(screen.getByText("Lower latency")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Other answer" }), {
      target: { value: "Custom mode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("ask-review").textContent).toContain("Custom mode");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(result.answers).toEqual([
      { kind: "ask", answers: [{ id: "q1", selectedOptions: [], customInput: "Custom mode" }] },
    ]);
  });

  const checkboxRequest: AskDialogRequest = {
    kind: "ask",
    id: "ask-2" as UiRequestId,
    questions: [
      {
        id: "tools",
        question: "Which tools should run?",
        options: [{ label: "Read" }, { label: "Grep" }, { label: "Bash" }],
        multi: true,
      },
    ],
  };

  test("a checkbox question marks each ticked option and says it takes any number of answers", () => {
    renderRequest(checkboxRequest);
    expect(screen.getByText("Choose any number of options.")).toBeTruthy();
    const read = screen.getByRole("checkbox", { name: "Read" });
    expect(markOf(read)).toBe("false");
    fireEvent.click(read);
    expect(read.getAttribute("aria-checked")).toBe("true");
    expect(markOf(read)).toBe("true");
  });

  test("text typed under Other stays when a checkbox is ticked, and both reach the answer", () => {
    const result = renderRequest(checkboxRequest);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Other answer" }), {
      target: { value: "Custom tool" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Read" }));
    expect(screen.getByRole("textbox", { name: "Other answer" })).toHaveProperty(
      "value",
      "Custom tool",
    );
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("ask-review").textContent).toContain("Read, Custom tool");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(result.answers).toEqual([
      {
        kind: "ask",
        answers: [{ id: "tools", selectedOptions: ["Read"], customInput: "Custom tool" }],
      },
    ]);
  });

  test("arrow keys move through a single-answer question and select the option focus reaches", () => {
    renderRequest(askRequest);
    expect(screen.getByText("Choose one option.")).toBeTruthy();
    const fast = screen.getByRole("radio", { name: /Fast/ });
    const thorough = screen.getByRole("radio", { name: /Thorough/ });
    expect(fast.tabIndex).toBe(0);
    expect(thorough.tabIndex).toBe(-1);
    fast.focus();
    fireEvent.keyDown(fast, { key: "ArrowDown" });
    expect(document.activeElement).toBe(thorough);
    expect(thorough.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(thorough, { key: "ArrowDown" });
    expect(document.activeElement).toBe(fast);
    expect(fast.getAttribute("aria-checked")).toBe("true");
  });

  test("arrow keys move focus between checkboxes without ticking them", () => {
    renderRequest(checkboxRequest);
    const read = screen.getByRole("checkbox", { name: "Read" });
    const grep = screen.getByRole("checkbox", { name: "Grep" });
    read.focus();
    fireEvent.keyDown(read, { key: "ArrowDown" });
    expect(document.activeElement).toBe(grep);
    expect(grep.getAttribute("aria-checked")).toBe("false");
  });

  const recommendedRequest: AskDialogRequest = {
    kind: "ask",
    id: "ask-3" as UiRequestId,
    questions: [
      {
        id: "mode",
        question: "Pick a mode",
        options: [{ label: "Fast" }, { label: "Thorough" }],
        recommended: 1,
      },
    ],
  };

  test("the recommended option carries a visible Recommended tag, and no other option does", () => {
    renderRequest(recommendedRequest);
    expect(
      within(screen.getByRole("radio", { name: /Thorough/ })).getByText("Recommended"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("radio", { name: /Fast/ })).queryByText("Recommended"),
    ).toBeNull();
  });

  test("the ask dialog counts down the time left and says what omp answers when it runs out", () => {
    vi.useFakeTimers();
    try {
      renderRequest(askRequest, Date.now() + 15_000);
      expect(screen.getByRole("timer").textContent).toBe("Time left: 15 seconds.");
      expect(screen.getByText(/When time runs out, omp uses its recommended answer/)).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByRole("timer").textContent).toBe("Time left: 14 seconds.");
      act(() => {
        vi.advanceTimersByTime(13_000);
      });
      expect(screen.getByRole("timer").textContent).toBe("Time left: 1 second.");
    } finally {
      vi.useRealTimers();
    }
  });

  test("an ask with no timeout shows no countdown and no line about a timeout", () => {
    renderRequest(askRequest);
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.queryByText(/When time runs out/)).toBeNull();
  });

  test("a checkbox question can be answered with none ticked: Review says None and Submit sends an empty set", () => {
    const result = renderRequest(checkboxRequest);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.queryByText("Choose an option or enter an answer before continuing.")).toBeNull();
    expect(screen.getByTestId("ask-review").textContent).toContain("None");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(result.answers).toEqual([
      { kind: "ask", answers: [{ id: "tools", selectedOptions: [] }] },
    ]);
  });

  test("a single-choice question still needs an answer before Review", () => {
    renderRequest(askRequest);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Choose an option or enter an answer before continuing.")).toBeTruthy();
  });

  test("the result card uses text-only rendering for normalized answers", () => {
    render(
      <AskResultCard
        request={askRequest}
        answers={[{ id: "q1", selectedOptions: ["Thorough"] }]}
      />,
    );
    expect(screen.getByTestId("ask-result-card").textContent).toContain("Thorough");
    expect(screen.getByRole("definition").textContent).toBe("Thorough");
  });
});

/** A dialog whose answers are refused while `state.refuse` is on: a refused answer never reaches omp. */
function renderRefusedAnswers(request: DialogRequest) {
  const answers: DialogResponse[] = [];
  const state = { refuse: true };
  const context: DialogRenderContext = {
    request,
    threadId,
    signal: new AbortController().signal,
    answer: async (response) => {
      if (state.refuse) throw new Error("omp did not accept the answer.");
      answers.push(response);
    },
    cancel: async () => undefined,
  };
  render(renderDialogRequest(request, context));
  return { answers, state };
}

describe("a refused answer", () => {
  test("an input keeps the typed value, says sending failed, and Continue sends the same value again", async () => {
    const result = renderRefusedAnswers({
      kind: "input",
      id: "input-refused" as UiRequestId,
      title: "Database name",
    } as DialogRequest);
    fireEvent.change(screen.getByLabelText("Database name"), { target: { value: "Postgres" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sending your answer failed. Try again.",
    );
    expect((screen.getByLabelText("Database name") as HTMLInputElement).value).toBe("Postgres");
    expect(result.answers).toEqual([]);

    result.state.refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(result.answers).toEqual([{ kind: "input", value: "Postgres" }]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a confirm whose answer is refused says so, and Confirm can be pressed again", async () => {
    const result = renderRefusedAnswers({
      kind: "confirm",
      id: "confirm-refused" as UiRequestId,
      title: "Delete workspace?",
      message: "This cannot be undone.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sending your answer failed. Try again.",
    );

    result.state.refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(result.answers).toEqual([{ kind: "confirm", confirmed: true }]));
  });

  test("a select whose answer is refused keeps the chosen option and says sending failed", async () => {
    const result = renderRefusedAnswers({
      kind: "select",
      id: "select-refused" as UiRequestId,
      title: "Choose",
      options: ["Alpha", "Beta"],
    });
    fireEvent.click(screen.getByRole("option", { name: "Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sending your answer failed. Try again.",
    );
    expect(screen.getByRole("option", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");

    result.state.refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(result.answers).toEqual([{ kind: "select", value: "Beta" }]));
  });
});
