import { AppFailure, type ModeChangeRequest, type ModeChangeResult } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { SlashCommandProvider, SlashRoute } from "@/modules/D2/slash";
import { completedRun } from "@/modules/D2/slash/test-support";
import type { PromptIntent } from "@/modules/U2/contract";
import type { CommandReport } from "./command-report/command-report";
import { runSlashRoute } from "./slash-commands";

const prompt: PromptIntent = { mode: "prompt", text: "/slow on", delivery: "new" };

/** A provider whose only job here is to be asked (or not) to run a command the usual way. */
function providerThatRuns(command: string) {
  const execute = vi.fn(async () => completedRun(command, "Ran the usual way."));
  const provider = { execute } as unknown as SlashCommandProvider;
  return { provider, execute };
}

/** A typed gateway that answers each mode change with `answer(request)`, and records each request. */
function typedGateway(answer: (request: ModeChangeRequest) => ModeChangeResult) {
  const requests: ModeChangeRequest[] = [];
  const runMode = vi.fn(async (request: ModeChangeRequest) => {
    requests.push(request);
    return answer(request);
  });
  return { runMode, requests };
}

describe("a mode command typed in the composer runs through the typed gateway", () => {
  test("an applied change shows the app's plain sentence, and the usual command path is not used", async () => {
    const shown: Array<string | null> = [];
    const { provider, execute } = providerThatRuns("/slow on");
    const { runMode, requests } = typedGateway(() => ({
      outcome: "applied",
      mode: "slow",
      on: true,
    }));
    const route: SlashRoute = { kind: "omp", command: "/slow on" };

    await runSlashRoute({
      route,
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: () => undefined,
      runMode,
    });

    expect(requests).toEqual([{ mode: "slow", requested: true }]);
    expect(execute).not.toHaveBeenCalled();
    expect(shown).toEqual([null, "Slow mode is on."]);
  });

  test("an unsupported change says so in plain words, and omp's own words are not shown", async () => {
    const shown: Array<string | null> = [];
    const { provider, execute } = providerThatRuns("/slow on");
    const { runMode } = typedGateway(() => ({
      outcome: "unsupported",
      mode: "slow",
      reason: "model-has-no-slow-mode",
    }));

    await runSlashRoute({
      route: { kind: "omp", command: "/slow on" },
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: () => undefined,
      runMode,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(shown).toEqual([null, "Slow mode is not available for this model."]);
  });

  test("a reply the app does not recognise shows omp's words as before, and is not claimed as applied", async () => {
    const shown: Array<string | null> = [];
    const { provider } = providerThatRuns("/computer on");
    const { runMode } = typedGateway(() => ({
      outcome: "unknown",
      mode: "computer",
      outputs: ["Computer use is on, I think."],
    }));

    await runSlashRoute({
      route: { kind: "omp", command: "/computer on" },
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: () => undefined,
      runMode,
    });

    expect(shown).toEqual([null, "omp: Computer use is on, I think."]);
  });

  test("a reply the app does not recognise with several lines shows them in the report panel", async () => {
    const shown: Array<string | null> = [];
    const reports: CommandReport[] = [];
    const { provider } = providerThatRuns("/computer on");
    const { runMode } = typedGateway(() => ({
      outcome: "unknown",
      mode: "computer",
      outputs: ["Computer use is on,", "I think."],
    }));

    await runSlashRoute({
      route: { kind: "omp", command: "/computer on" },
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: (report) => reports.push(report),
      runMode,
    });

    expect(shown).toEqual([null]);
    expect(reports).toEqual([{ command: "/computer on", text: "Computer use is on,\nI think." }]);
  });

  test("a browser window that did not restart says so in plain words, with the window it asked for left out", async () => {
    const shown: Array<string | null> = [];
    const { provider } = providerThatRuns("/browser visible");
    const { runMode, requests } = typedGateway(() => ({
      outcome: "refused",
      mode: "browser",
      reason: "browser-restart-failed",
    }));

    await runSlashRoute({
      route: { kind: "omp", command: "/browser visible" },
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: () => undefined,
      runMode,
    });

    expect(requests).toEqual([{ mode: "browser", visibility: "visible" }]);
    expect(shown).toEqual([null, "The browser could not restart in that window. Try again."]);
  });

  test("a change that fails throws, so the composer keeps the typed text", async () => {
    const { provider } = providerThatRuns("/slow on");
    const runMode = vi.fn(async () => {
      throw new AppFailure({
        code: "cancelled",
        message: "The change was cancelled.",
        retryable: false,
      });
    });

    await expect(
      runSlashRoute({
        route: { kind: "omp", command: "/slow on" },
        intent: prompt,
        provider,
        showStatus: () => undefined,
        showReport: () => undefined,
        runMode,
      }),
    ).rejects.toMatchObject({ appError: { code: "cancelled" } });
  });

  test("a spelling that is not one of the four changes (a bare toggle or a status form) runs the usual way", async () => {
    const shown: Array<string | null> = [];
    const { provider, execute } = providerThatRuns("/slow status");
    const { runMode } = typedGateway(() => ({ outcome: "applied", mode: "slow", on: true }));

    await runSlashRoute({
      route: { kind: "omp", command: "/slow status" },
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: () => undefined,
      runMode,
    });

    expect(runMode).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([null, "omp: Ran the usual way."]);
  });

  test("without the typed gateway, a mode command runs the usual way, as before", async () => {
    const shown: Array<string | null> = [];
    const { provider, execute } = providerThatRuns("/slow on");

    await runSlashRoute({
      route: { kind: "omp", command: "/slow on" },
      intent: prompt,
      provider,
      showStatus: (text) => shown.push(text),
      showReport: () => undefined,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([null, "omp: Ran the usual way."]);
  });
});
