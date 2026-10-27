import { describe, expect, test } from "bun:test";
import type { UiEvent } from "@omp-app/contracts/chat-host";
import { HostRequests, HostUIContext } from "./ui-context";

/** A UI context whose requests are kept for the test to answer. */
function harness() {
  const sent: { id: string; method: string; params: unknown }[] = [];
  const events: UiEvent[] = [];
  const requests = new HostRequests((message) => {
    sent.push(message as { id: string; method: string; params: unknown });
    return true;
  });
  const ui = new HostUIContext(requests, (event) => events.push(event));
  const answer = (index: number, result: unknown) =>
    requests.settle({ kind: "response", id: sent[index]?.id ?? "", ok: true, result });
  return { sent, events, requests, ui, answer };
}

describe("the host's requests", () => {
  test("an answer omp does not take fails the dialog, and an answer to no waiting request settles nothing", async () => {
    const { ui, answer, requests } = harness();
    const typed = ui.input("Name");
    expect(answer(0, { value: 42 })).toBe(true);
    await expect(typed).rejects.toThrow("The app's answer to ui.input is not one omp takes");
    expect(
      requests.settle({ kind: "response", id: "host-99", ok: true, result: { value: "x" } }),
    ).toBe(false);
  });

  test("once the app is gone, waiting and later dialogs fail instead of waiting forever", async () => {
    const { ui, requests } = harness();
    const waiting = ui.confirm("Go on?", "It runs the check");
    requests.closeAll("The app closed the chat");
    await expect(waiting).rejects.toThrow("The app closed the chat");
    await expect(ui.select("Pick", ["a"])).rejects.toThrow("The app closed the chat");
  });
});

describe("dialogs omp closes itself", () => {
  test("an abort answers the dialog's default, tells the app, and a late answer changes nothing", async () => {
    const { ui, sent, events, answer } = harness();
    const controller = new AbortController();
    const confirmed = ui.confirm("Go on?", "It runs the check", { signal: controller.signal });
    controller.abort();
    expect(await confirmed).toBe(false);
    expect(events).toEqual([{ type: "ui_cancel", requestId: sent[0]?.id ?? "" }]);
    expect(answer(0, { confirmed: true })).toBe(false);
  });

  test("omp's timeout calls its onTimeout once and answers the default; the app's own countdown calls it too", async () => {
    const { ui, events, answer } = harness();
    let timeouts = 0;
    const onTimeout = () => {
      timeouts++;
    };
    expect(await ui.select("Quick", ["a", "b"], { timeout: 5, onTimeout })).toBeUndefined();
    expect(timeouts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["ui_cancel"]);
    const picked = ui.select("Again", ["a", "b"], { onTimeout });
    answer(1, { cancelled: true, timedOut: true });
    expect(await picked).toBeUndefined();
    expect(timeouts).toBe(2);
  });

  test("an aborted signal opens no dialog at all", async () => {
    const { ui, sent } = harness();
    expect(await ui.input("Name", undefined, { signal: AbortSignal.abort() })).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe("the ask dialog", () => {
  const questions = [
    { id: "colour", question: "Which colour?", options: [{ label: "red" }, { label: "blue" }] },
  ];

  test("is offered only when turned on, and its answers are checked against the questions", async () => {
    const { ui, answer } = harness();
    expect(ui.askDialog).toBeUndefined();
    ui.askDialogEnabled = true;
    const unknown = ui.askDialog?.(questions);
    answer(0, { answers: [{ id: "colour", selectedOptions: ["green"] }] });
    await expect(unknown).rejects.toThrow('selected unknown option "green"');
    const asked = ui.askDialog?.(questions);
    answer(1, { answers: [{ id: "colour", selectedOptions: ["blue"], customInput: "  " }] });
    expect(await asked).toEqual({
      kind: "submit",
      results: [
        {
          id: "colour",
          question: "Which colour?",
          options: ["red", "blue"],
          multi: false,
          selectedOptions: ["blue"],
          customInput: undefined,
        },
      ],
    });
  });
});
