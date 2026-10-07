import type { AppError, CommandRunResult, ThreadId } from "@omp-app/contracts";
import {
  AppFailure,
  CommandDescriptor,
  SlashCommand,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PanelState } from "@/modules/U5/panel/contract";
import type { P7CommandPort } from "../contract";
import {
  CommandReportPanel,
  CommandResultContent,
  P7_COMMAND_DESCRIPTORS,
  parseCompactArgs,
  parseP7Command,
  parseStatsArgs,
  parseUsageArgs,
  runP7Command,
  validateP7Command,
} from "./index";

afterEach(cleanup);

const threadId: ThreadId = ThreadIdSchema.parse("p7-command-test");
const panelState: PanelState = {
  open: true,
  lifecycle: "populated",
  position: "right",
  title: "Command report",
  description: "Read the result of a command.",
  error: null,
  readOnly: true,
  pendingUpdates: 0,
};

function commandResult(overrides: Partial<CommandRunResult> = {}): CommandRunResult {
  return {
    command: SlashCommand.parse("/stats --port 3847"),
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [],
    sessionUpdates: [],
    configUpdates: [],
    ...overrides,
  };
}

function reportResult(): CommandRunResult {
  return commandResult({
    agentInvoked: true,
    promptSettled: false,
    sessionSettled: false,
    outputs: [{ text: "First report section" }, { text: "Second report section" }],
    sessionUpdates: [{ sessionId: threadId, title: "Quarterly plan" }],
    configUpdates: [
      {
        model: {
          id: "sample-model-id",
          name: "Sample model",
          provider: "sample-provider",
          reasoning: true,
        },
        thinkingLevel: "xhigh",
      },
    ],
  });
}

describe("P7 command descriptors and invocation", () => {
  test("registers all four built-in commands and covers each command inventory row once", () => {
    expect(P7_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.slash?.name)).toEqual([
      "context",
      "stats",
      "usage",
      "compact",
    ]);
    const covered = P7_COMMAND_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(new Set(covered).size).toBe(covered.length);
    for (const descriptor of P7_COMMAND_DESCRIPTORS) {
      expect(CommandDescriptor.safeParse(descriptor).success).toBe(true);
      expect(descriptor.requires).toContain("host.command-gateway");
    }
  });

  test("preserves the full argument text for the typed command gateway", async () => {
    const result = reportResult();
    const run = vi.fn<P7CommandPort["run"]>(async () => result);
    const gateway: P7CommandPort = { run };
    const command = "/compact   a phrase with spaces";

    await expect(runP7Command(gateway, threadId, command)).resolves.toBe(result);
    expect(run.mock.calls[0]?.[0]).toEqual({
      threadId,
      command: SlashCommand.parse(command),
    });
  });

  test("turns invalid syntax into a typed failure and does not call omp", async () => {
    const run = vi.fn<P7CommandPort["run"]>(async () => reportResult());
    const gateway: P7CommandPort = { run };

    await expect(runP7Command(gateway, threadId, "/stats --port 65536")).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "Invalid port: 65536",
        retryable: false,
      },
    });
    await expect(
      runP7Command(gateway, threadId, "/compact snapcompact keep this"),
    ).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message:
          "/compact snapcompact does not take focus instructions (it archives history without an LLM summary).",
        retryable: false,
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("keeps gateway failures typed instead of matching command output text", async () => {
    const failure = new AppFailure({
      code: "timeout",
      message: "The command timed out.",
      retryable: true,
    });
    const run = vi.fn<P7CommandPort["run"]>(async () => {
      throw failure;
    });
    const gateway: P7CommandPort = { run };

    await expect(runP7Command(gateway, threadId, "/context")).rejects.toBe(failure);
  });
});

describe("P7 exact command grammar", () => {
  test("accepts only the P7 command names and preserves the command remainder", () => {
    expect(parseP7Command("/context")).toMatchObject({
      state: "valid",
      value: { name: "context", args: "" },
    });
    expect(parseP7Command("/stats -p 8080 --host localhost")).toMatchObject({
      state: "valid",
      value: { name: "stats", args: "-p 8080 --host localhost" },
    });
    expect(parseP7Command("/compact unknown focus text")).toMatchObject({
      state: "valid",
      value: { name: "compact", args: "unknown focus text" },
    });
    expect(parseP7Command("/not-a-p7-command")).toEqual({
      state: "invalid",
      message: "That command is not available here.",
    });
    expect(parseP7Command("stats")).toEqual({
      state: "invalid",
      message: "Enter a command starting with a slash.",
    });
  });

  test("matches stats defaults, options, port boundaries, and usage errors", () => {
    expect(parseStatsArgs("")).toEqual({
      state: "valid",
      value: { port: 3847, host: "127.0.0.1" },
    });
    expect(parseStatsArgs("-p 0 --host=localhost")).toEqual({
      state: "valid",
      value: { port: 0, host: "localhost" },
    });
    expect(parseStatsArgs("--port=65535 --host [::1]")).toEqual({
      state: "valid",
      value: { port: 65_535, host: "[::1]" },
    });
    expect(parseStatsArgs("--port")).toEqual({
      state: "invalid",
      message: "Missing port. Usage: /stats [--port <port>] [--host <host>]",
    });
    expect(parseStatsArgs("--port 65536")).toEqual({
      state: "invalid",
      message: "Invalid port: 65536",
    });
    expect(parseStatsArgs("--host=")).toEqual({
      state: "invalid",
      message: "Missing host. Usage: /stats [--port <port>] [--host <host>]",
    });
    expect(parseStatsArgs("--color")).toEqual({
      state: "invalid",
      message: "Unknown option: --color. Usage: /stats [--port <port>] [--host <host>]",
    });
  });

  test("matches usage show/reset forms and rejects other subcommands with omp's usage text", () => {
    expect(parseUsageArgs("")).toEqual({ state: "valid", value: { kind: "show" } });
    expect(parseUsageArgs(" SHOW ")).toEqual({ state: "valid", value: { kind: "show" } });
    expect(parseUsageArgs("reset")).toEqual({
      state: "valid",
      value: { kind: "reset", target: null },
    });
    expect(parseUsageArgs("reset openai-codex/active")).toEqual({
      state: "valid",
      value: { kind: "reset", target: "openai-codex/active" },
    });
    expect(parseUsageArgs("reset anthropic/42")).toEqual({
      state: "valid",
      value: { kind: "reset", target: "anthropic/42" },
    });
    expect(parseUsageArgs("show extra")).toEqual({
      state: "invalid",
      message: "Usage: /usage [show|reset [provider/credential-id|provider/active]]",
    });
    expect(validateP7Command("/usage forget")).toEqual({
      state: "invalid",
      message: "Usage: /usage [show|reset [provider/credential-id|provider/active]]",
    });
  });

  test("handles compact modes case-insensitively and preserves unknown first tokens as focus", () => {
    expect(parseCompactArgs("")).toEqual({
      state: "valid",
      value: { mode: null, focus: null },
    });
    expect(parseCompactArgs("REMOTE keep the latest decisions")).toEqual({
      state: "valid",
      value: { mode: "remote", focus: "keep the latest decisions" },
    });
    expect(parseCompactArgs("snapcompact")).toEqual({
      state: "valid",
      value: { mode: "snapcompact", focus: null },
    });
    expect(parseCompactArgs("preserve the open migration plan")).toEqual({
      state: "valid",
      value: { mode: null, focus: "preserve the open migration plan" },
    });
    expect(parseCompactArgs("snapcompact keep the open plan")).toEqual({
      state: "invalid",
      message:
        "/compact snapcompact does not take focus instructions (it archives history without an LLM summary).",
    });
  });
});

describe("P7 command output presentation", () => {
  test("preserves output order and presents safe updates and settlement as separate statuses", () => {
    const { container } = render(
      <CommandResultContent error={null} loading={false} result={reportResult()} />,
    );
    const outputs = container.querySelectorAll('[data-u1-row-kind="custom-message"]');
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.textContent).toContain("First report section");
    expect(outputs[1]?.textContent).toContain("Second report section");
    expect(screen.getByText("A response was started.")).toBeTruthy();
    expect(screen.getByText("The prompt has not settled yet.")).toBeTruthy();
    expect(screen.getByText("The session has not settled yet.")).toBeTruthy();
    expect(screen.getByText("Conversation title changed")).toBeTruthy();
    expect(screen.getByText("Quarterly plan")).toBeTruthy();
    expect(screen.getByText("Sample model")).toBeTruthy();
    expect(screen.getByText("Extra high")).toBeTruthy();
    expect(screen.queryByText("sample-model-id")).toBeNull();
    expect(screen.queryByText("sample-provider")).toBeNull();
    expect(screen.queryByText("xhigh")).toBeNull();
  });

  test("keeps command output as safe text and shows empty, loading, cancelled, and retry states", () => {
    const unsafeOutput = commandResult({
      outputs: [{ text: "<script>do not run</script>" }],
    });
    const { container, rerender } = render(
      <CommandResultContent error={null} loading={false} result={unsafeOutput} />,
    );
    expect(screen.getByText("<script>do not run</script>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();

    rerender(<CommandResultContent error={null} loading={true} result={null} />);
    expect(screen.getByRole("status").textContent).toContain("Running the command");
    expect(screen.queryByText("No command result yet.")).toBeNull();

    rerender(
      <CommandResultContent
        error={null}
        loading={false}
        result={commandResult({ status: "aborted" })}
      />,
    );
    expect(screen.getByText("The command was cancelled before it finished.")).toBeTruthy();

    const onRetry = vi.fn();
    const error: AppError = {
      code: "timeout",
      message: "The command timed out.",
      retryable: true,
    };
    rerender(
      <CommandResultContent error={error} loading={false} onRetry={onRetry} result={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("uses U5.2 for a closeable report panel", () => {
    const onOpenChange = vi.fn();
    render(
      <CommandReportPanel
        error={null}
        loading={false}
        onOpenChange={onOpenChange}
        panelState={panelState}
        result={reportResult()}
      />,
    );
    expect(screen.getByRole("region", { name: "Command report" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Command report" }));
    expect(onOpenChange).toHaveBeenCalledWith(false, "close-button");
  });
});
