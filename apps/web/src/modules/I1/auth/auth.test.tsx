import { AppFailure, type CapabilityMap, type OmpWire, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type {
  ConfirmDialogRequest,
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResultFor,
} from "../../U4/contract";
import { renderDialogRequest } from "../../U4/dialogs";
import { DialogHostController } from "../../U4/host";
import { McpServerSummary } from "../contract";
import type { McpAddServerArgs, McpServerLifecyclePort } from "../servers";
import {
  getMcpAuthAvailability,
  getMcpServerAuthViewModel,
  MCP_AUTH_ACTION_CAPABILITIES,
  MCP_AUTH_ACTIONS,
  MCP_AUTH_CAPABILITY,
  MCP_AUTH_UNAVAILABLE_REASON,
  type McpAddWizardResult,
  McpServerAuthStatus,
  runMcpAddWizard,
} from ".";

const threadId = ThreadId.parse("thread-i1-auth-test");

type DialogAnswer =
  | { readonly kind: "select"; readonly value: string }
  | { readonly kind: "input"; readonly value: string }
  | { readonly kind: "editor"; readonly value: string }
  | { readonly kind: "cancelled"; readonly timedOut?: boolean };

type DialogHarness = {
  readonly answers: DialogAnswer[];
  readonly confirmations: boolean[];
  readonly requests: DialogRequest[];
  readonly confirmRequests: ConfirmDialogRequest[];
  readonly signals: Array<AbortSignal | undefined>;
  readonly origins: Array<DialogHostOpenOptions["origin"]>;
};

type ServerHarness = {
  readonly addArgs: McpAddServerArgs[];
  readonly testArgs: Array<Parameters<McpServerLifecyclePort["test"]>[0]>;
  testFailure: AppFailure | null;
};

function dialogHarness(
  answers: readonly DialogAnswer[],
  confirmations: readonly boolean[] = [true],
) {
  const state: DialogHarness = {
    answers: [...answers],
    confirmations: [...confirmations],
    requests: [],
    confirmRequests: [],
    signals: [],
    origins: [],
  };
  const dialogs: DialogHost = {
    async open<R extends DialogRequest>(
      request: R,
      options: DialogHostOpenOptions,
    ): Promise<DialogResultFor<R>> {
      state.requests.push(request);
      state.signals.push(options.signal);
      state.origins.push(options.origin);
      const answer = state.answers.shift();
      if (!answer) throw new Error("The test did not provide a response for this dialog.");
      if (answer.kind === "cancelled") {
        return {
          outcome: "cancelled",
          kind: request.kind,
          timedOut: answer.timedOut ?? false,
        } as DialogResultFor<R>;
      }
      if (answer.kind !== request.kind) {
        throw new Error(`Expected a ${request.kind} dialog answer, received ${answer.kind}.`);
      }
      switch (request.kind) {
        case "select":
          if (answer.kind === "select") {
            return {
              outcome: "answered",
              response: { kind: "select", value: answer.value },
            } as DialogResultFor<R>;
          }
          break;
        case "input":
          if (answer.kind === "input") {
            return {
              outcome: "answered",
              response: { kind: "input", value: answer.value },
            } as DialogResultFor<R>;
          }
          break;
        case "editor":
          if (answer.kind === "editor") {
            return {
              outcome: "answered",
              response: { kind: "editor", value: answer.value },
            } as DialogResultFor<R>;
          }
          break;
      }
      throw new Error("The test response did not match the requested dialog.");
    },
    async confirm(request, options) {
      state.confirmRequests.push(request);
      state.signals.push(options.signal);
      state.origins.push(options.origin);
      return state.confirmations.shift() ?? false;
    },
  };
  return { dialogs, state };
}
type AppOwnedDialogHarnessState = {
  controller: DialogHostController | undefined;
  readonly answerExtensionUi: OmpWire.ExtensionUiResponse[];
  readonly requestIds: string[];
};

function AppOwnedDialogHarness({ state }: { readonly state: AppOwnedDialogHarnessState }) {
  const overlay = useOverlayHost();
  const controllerRef = useRef<DialogHostController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new DialogHostController({
      overlay,
      capabilities: {},
      answerExtensionUi: async (response) => {
        state.answerExtensionUi.push(response);
      },
      render: (request, context) => {
        state.requestIds.push(request.id);
        return renderDialogRequest(request, context);
      },
    });
  }
  const controller = controllerRef.current;
  useEffect(() => {
    state.controller = controller;
    return () => {
      controller.dispose();
      state.controller = undefined;
    };
  }, [controller, state]);
  return null;
}

function renderAppOwnedDialogHost(): AppOwnedDialogHarnessState {
  const state: AppOwnedDialogHarnessState = {
    controller: undefined,
    answerExtensionUi: [],
    requestIds: [],
  };
  render(
    <OverlayHost>
      <AppOwnedDialogHarness state={state} />
    </OverlayHost>,
  );
  return state;
}

function serverHarness(): {
  readonly state: ServerHarness;
  readonly servers: Pick<McpServerLifecyclePort, "add" | "test">;
} {
  const state: ServerHarness = { addArgs: [], testArgs: [], testFailure: null };
  const servers: Pick<McpServerLifecyclePort, "add" | "test"> = {
    async add(args) {
      state.addArgs.push(args);
      const server = McpServerSummary.parse({
        name: args.name,
        scope: args.scope,
        transport: args.transport ?? (args.url ? "http" : "stdio"),
        enabled: true,
        status: "configured",
        ...(args.url ? { url: new URL(args.url).origin } : {}),
        ...(args.command ? { command: args.command } : {}),
        auth: "none",
        source: { origin: args.scope, reloadRequired: true },
      });
      return { operationId: args.operationId, status: "configured", server };
    },
    async test(args) {
      state.testArgs.push(args);
      if (state.testFailure) throw state.testFailure;
      return { operationId: args.operationId, status: "ready", server: null };
    },
  };
  return { state, servers };
}

function wizardOptions(dialogs: DialogHost, servers: Pick<McpServerLifecyclePort, "add" | "test">) {
  return { dialogs, servers, threadId };
}

function requireAdded(result: McpAddWizardResult) {
  if (result.status !== "added") throw new Error("Expected the MCP server to be saved.");
  return result;
}

afterEach(() => cleanup());

describe("I1 MCP auth capability gate", () => {
  test("maps reauth, unauth and Smithery login/logout to the upstream capability", () => {
    expect(MCP_AUTH_CAPABILITY).toBe("upstream.mcp-auth");
    expect(Object.values(MCP_AUTH_ACTION_CAPABILITIES)).toEqual(
      Array(MCP_AUTH_ACTIONS.length).fill(MCP_AUTH_CAPABILITY),
    );
    for (const action of MCP_AUTH_ACTIONS) {
      expect(getMcpAuthAvailability(action, {})).toEqual({
        state: "unavailable",
        capability: MCP_AUTH_CAPABILITY,
        reason: MCP_AUTH_UNAVAILABLE_REASON,
      });
    }

    const capabilities: CapabilityMap = {
      [MCP_AUTH_CAPABILITY]: { state: "available", via: "upstream" },
    };
    for (const action of MCP_AUTH_ACTIONS) {
      expect(getMcpAuthAvailability(action, capabilities)).toEqual({
        state: "available",
        capability: MCP_AUTH_CAPABILITY,
      });
    }
  });

  test("renders only auth type and connection status from the typed MCP summary", () => {
    const server = McpServerSummary.parse({
      name: "remote",
      scope: "user",
      transport: "http",
      enabled: true,
      status: "configured",
      url: "https://mcp.example.test",
      auth: "unknown",
      source: { origin: "user", reloadRequired: true },
    });
    const viewModel = getMcpServerAuthViewModel(server, {});
    expect(viewModel).toEqual({
      authenticationType: "Not reported",
      connectionStatus: "Configured",
      authActionsAvailable: false,
      unavailableReason: MCP_AUTH_UNAVAILABLE_REASON,
    });
    render(<McpServerAuthStatus viewModel={viewModel} />);
    expect(screen.getByText("Authentication type: Not reported.")).toBeTruthy();
    expect(screen.getByText("Server connection: Configured.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(MCP_AUTH_UNAVAILABLE_REASON);
    expect(document.body.textContent).not.toContain("https://mcp.example.test");

    const availableCapabilities: CapabilityMap = {
      [MCP_AUTH_CAPABILITY]: { state: "available", via: "upstream" },
    };
    const availableViewModel = getMcpServerAuthViewModel(server, availableCapabilities);
    expect(availableViewModel).toMatchObject({ authActionsAvailable: true });
    expect(availableViewModel.unavailableReason).toBeUndefined();
  });
});

describe("I1 MCP add wizard", () => {
  test("adds a safe stdio config through I1.3 and tests it after saving", async () => {
    const dialog = dialogHarness([
      { kind: "select", value: "Local process" },
      { kind: "input", value: "filesystem" },
      { kind: "select", value: "Project" },
      { kind: "input", value: "node" },
      { kind: "editor", value: "-y\nmcp-filesystem" },
    ]);
    const server = serverHarness();
    const result = requireAdded(
      await runMcpAddWizard(wizardOptions(dialog.dialogs, server.servers)),
    );

    expect(result.server).toMatchObject({
      name: "filesystem",
      scope: "project",
      transport: "stdio",
      command: "node",
      auth: "none",
      status: "configured",
    });
    expect(result.test).toEqual({ status: "passed" });
    expect(server.state.addArgs).toHaveLength(1);
    expect(server.state.addArgs[0]).toMatchObject({
      name: "filesystem",
      scope: "project",
      transport: "stdio",
      command: "node",
      args: ["-y", "mcp-filesystem"],
    });
    expect(server.state.testArgs).toHaveLength(1);
    expect(server.state.testArgs[0]).toMatchObject({
      name: "filesystem",
      scope: "project",
    });
    expect(JSON.stringify(server.state.addArgs[0])).not.toContain("headers");
    expect(JSON.stringify(server.state.addArgs[0])).not.toContain("env");
    expect(dialog.state.signals.every((signal) => signal !== undefined)).toBe(true);
    const requestIds = [
      ...dialog.state.requests.map((request) => request.id),
      ...dialog.state.confirmRequests.map((request) => request.id),
    ];
    expect(dialog.state.origins).toEqual(Array(requestIds.length).fill("app"));
    expect(requestIds.every((id) => id.startsWith("app-"))).toBe(true);
  });
  test("uses app-owned U4 dialogs without answering omp extension UI", async () => {
    const state = renderAppOwnedDialogHost();
    await waitFor(() => expect(state.controller).toBeDefined());
    const dialogs = state.controller;
    if (!dialogs) throw new Error("The app-owned DialogHost was not created.");
    const server = serverHarness();
    const wizard = runMcpAddWizard({ dialogs, servers: server.servers, threadId });

    await screen.findByRole("option", { name: /Local process/ });
    fireEvent.click(screen.getByRole("option", { name: /Local process/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    const name = await screen.findByRole("textbox", { name: "MCP server name" });
    fireEvent.change(name, { target: { value: "filesystem" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("option", { name: /Project/ });
    fireEvent.click(screen.getByRole("option", { name: /Project/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    const command = await screen.findByRole("textbox", { name: "Executable for the MCP server" });
    fireEvent.change(command, { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const args = await screen.findByRole("textbox", {
      name: "Command arguments (one argument per line; do not enter credentials)",
    });
    fireEvent.change(args, { target: { value: "-y\\nmcp-filesystem" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Confirm" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const result = requireAdded(await wizard);
    expect(result.test).toEqual({ status: "passed" });
    expect(state.requestIds).toHaveLength(6);
    expect(state.requestIds.every((id) => id.startsWith("app-"))).toBe(true);
    expect(state.answerExtensionUi).toEqual([]);
  });

  test("rejects unsafe HTTP addresses, accepts paths and keeps query data out of the summary", async () => {
    const dialog = dialogHarness([
      { kind: "select", value: "Remote web server" },
      { kind: "input", value: "remote" },
      { kind: "select", value: "User" },
      { kind: "input", value: "https://mcp.example.test/path?view=1" },
      { kind: "input", value: "https://mcp.example.test/api/mcp" },
    ]);
    const server = serverHarness();
    const result = requireAdded(
      await runMcpAddWizard(wizardOptions(dialog.dialogs, server.servers)),
    );

    expect(result.server).toMatchObject({
      name: "remote",
      scope: "user",
      transport: "http",
      url: "https://mcp.example.test",
    });
    expect(
      dialog.state.requests
        .filter((request) => request.kind === "input")
        .map((request) => request.title),
    ).toEqual([
      "MCP server name",
      "MCP server address",
      "MCP server address — Enter an HTTP(S) server address without credentials, query strings or fragments.",
    ]);
    expect(server.state.addArgs[0]).toMatchObject({
      name: "remote",
      scope: "user",
      transport: "http",
      url: "https://mcp.example.test/api/mcp",
    });
    expect(JSON.stringify(server.state.addArgs[0])).not.toContain("view=1");
  });

  test("stops before any write when U4 cancels or denies the final save", async () => {
    const cancelledDialog = dialogHarness([{ kind: "cancelled" }]);
    const cancelledServer = serverHarness();
    await expect(
      runMcpAddWizard(wizardOptions(cancelledDialog.dialogs, cancelledServer.servers)),
    ).resolves.toEqual({ status: "cancelled", timedOut: false });
    expect(cancelledServer.state.addArgs).toHaveLength(0);
    expect(cancelledServer.state.testArgs).toHaveLength(0);
    const timeoutDialog = dialogHarness([
      { kind: "select", value: "Local process" },
      { kind: "cancelled", timedOut: true },
    ]);
    const timeoutServer = serverHarness();
    await expect(
      runMcpAddWizard(wizardOptions(timeoutDialog.dialogs, timeoutServer.servers)),
    ).resolves.toEqual({ status: "cancelled", timedOut: true });
    expect(timeoutServer.state.addArgs).toHaveLength(0);
    expect(timeoutServer.state.testArgs).toHaveLength(0);

    const deniedDialog = dialogHarness(
      [
        { kind: "select", value: "Remote event stream" },
        { kind: "input", value: "events" },
        { kind: "select", value: "Project" },
        { kind: "input", value: "https://events.example.test" },
      ],
      [false],
    );
    const deniedServer = serverHarness();
    await expect(
      runMcpAddWizard(wizardOptions(deniedDialog.dialogs, deniedServer.servers)),
    ).resolves.toEqual({ status: "cancelled" });
    expect(deniedServer.state.addArgs).toHaveLength(0);
    expect(deniedServer.state.testArgs).toHaveLength(0);
  });

  test("keeps a saved server visible when its typed connection test fails", async () => {
    const dialog = dialogHarness([
      { kind: "select", value: "Remote web server" },
      { kind: "input", value: "remote" },
      { kind: "select", value: "Project" },
      { kind: "input", value: "https://mcp.example.test" },
    ]);
    const server = serverHarness();
    server.state.testFailure = new AppFailure({
      code: "unavailable",
      message: "The remote server is unavailable.",
      retryable: true,
    });
    const result = requireAdded(
      await runMcpAddWizard(wizardOptions(dialog.dialogs, server.servers)),
    );

    expect(server.state.addArgs).toHaveLength(1);
    expect(server.state.testArgs).toHaveLength(1);
    expect(result.server.name).toBe("remote");
    expect(result.test).toMatchObject({
      status: "failed",
      error: { code: "unavailable", message: "The remote server is unavailable." },
    });
  });
});
