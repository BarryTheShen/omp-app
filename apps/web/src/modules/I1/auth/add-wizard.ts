import type { AppError, ThreadId } from "@omp-app/contracts";
import { AppFailure, McpCommandRemoteUrl, UiRequestId } from "@omp-app/contracts";
import type {
  ConfirmDialogRequest,
  DialogHost,
  DialogHostOpenOptions,
  DialogResultFor,
  EditorDialogRequest,
  SelectDialogRequest,
} from "../../U4/contract";
import type { McpServerSummary } from "../contract";
import { I1_CAPABILITIES, McpServerName, McpTransport, toI1Failure } from "../contract";
import type { McpAddServerArgs, McpServerLifecyclePort } from "../servers";

const ADD_WIZARD_TIMEOUT_MS = 300_000;

const TRANSPORT_OPTIONS = [
  {
    value: "stdio",
    label: "Local process",
    description: "Run an MCP server process on this machine.",
  },
  {
    value: "http",
    label: "Remote web server",
    description: "Connect to a remote server that responds to web requests.",
  },
  {
    value: "sse",
    label: "Remote event stream",
    description: "Connect to a server that streams updates.",
  },
] as const;

const SCOPE_OPTIONS = [
  { value: "project", label: "Project", description: "Available in this working directory." },
  { value: "user", label: "User", description: "Available to this omp profile." },
] as const;

type TextInputOutcome<Value> =
  | { readonly status: "answered"; readonly value: Value }
  | { readonly status: "cancelled"; readonly timedOut: boolean };

type TextValidation<Value> =
  | { readonly valid: true; readonly value: Value }
  | { readonly valid: false; readonly message: string };

type TextValidator<Value> = (value: string) => TextValidation<Value>;

type McpTestOutcome =
  | { readonly status: "passed" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: AppError };

export type McpAddWizardResult =
  | { readonly status: "cancelled"; readonly timedOut?: boolean }
  | {
      readonly status: "added";
      readonly server: McpServerSummary;
      readonly test: McpTestOutcome;
    };

export type McpAddWizardOptions = {
  readonly dialogs: DialogHost;
  readonly servers: Pick<McpServerLifecyclePort, "add" | "test">;
  readonly threadId: ThreadId;
  readonly signal?: AbortSignal;
};

function nextDialogId(): UiRequestId {
  return UiRequestId.parse(`app-i1-mcp-add-${crypto.randomUUID()}`);
}

async function promptValidatedInput<Value>(
  dialogs: DialogHost,
  options: DialogHostOpenOptions,
  title: string,
  placeholder: string,
  validate: TextValidator<Value>,
): Promise<TextInputOutcome<Value>> {
  let promptTitle = title;
  while (true) {
    const result = await dialogs.open(
      {
        kind: "input",
        id: nextDialogId(),
        title: promptTitle,
        placeholder,
        timeoutMs: ADD_WIZARD_TIMEOUT_MS,
      },
      options,
    );
    if (result.outcome === "cancelled") return { status: "cancelled", timedOut: result.timedOut };
    const validation = validate(result.response.value);
    if (validation.valid) return { status: "answered", value: validation.value };
    promptTitle = `${title} — ${validation.message}`;
  }
}

function serverNameInput(value: string): TextValidation<string> {
  const parsed = McpServerName.safeParse(value.trim());
  if (parsed.success) return { valid: true, value: parsed.data };
  return {
    valid: false,
    message: "Use a name with letters, numbers, periods, underscores or hyphens.",
  };
}

function serverUrlInput(value: string): TextValidation<string> {
  const parsed = McpCommandRemoteUrl.safeParse(value.trim());
  if (!parsed.success) {
    return {
      valid: false,
      message: "Enter an HTTP(S) server address without credentials, query strings or fragments.",
    };
  }
  return { valid: true, value: parsed.data };
}

function commandInput(value: string): TextValidation<string> {
  const command = value.trim();
  if (command.length > 0 && command.length <= 1_024 && !command.includes("\0")) {
    return { valid: true, value: command };
  }
  return { valid: false, message: "Enter a non-empty executable path." };
}

function selectionCancelled(
  result: DialogResultFor<SelectDialogRequest>,
): result is Extract<DialogResultFor<SelectDialogRequest>, { readonly outcome: "cancelled" }> {
  return result.outcome === "cancelled";
}

function editorCancelled(
  result: DialogResultFor<EditorDialogRequest>,
): result is Extract<DialogResultFor<EditorDialogRequest>, { readonly outcome: "cancelled" }> {
  return result.outcome === "cancelled";
}

function scopeFromLabel(label: string): "user" | "project" | undefined {
  if (label === "Project") return "project";
  if (label === "User") return "user";
  return undefined;
}

async function testAddedServer(
  servers: Pick<McpServerLifecyclePort, "test">,
  server: McpServerSummary,
  signal: AbortSignal,
): Promise<McpTestOutcome> {
  try {
    const result = await servers.test(
      { name: server.name, scope: server.scope, operationId: crypto.randomUUID() },
      { signal },
    );
    if (result.status === "ready") return { status: "passed" };
    return {
      status: "failed",
      error: new AppFailure({
        code: "unavailable",
        message: "The server was saved, but omp did not report a successful connection test.",
        retryable: true,
        capability: I1_CAPABILITIES.mcp,
      }).appError,
    };
  } catch (error) {
    const failure = toI1Failure(error, "The server was saved, but its connection test failed.");
    if (failure.appError.code === "cancelled") return { status: "cancelled" };
    return { status: "failed", error: failure.appError };
  }
}

/**
 * Collects non-secret configuration through U4 and I1.3. ACP add saves the config before its
 * configured-server test (omp v18.6.1 `helpers/mcp.ts:278-330`), so test status follows saving.
 * A save that fails as `cancelled` may already have been applied: that failure is rethrown
 * unchanged, and the caller must refresh its server list before any retry.
 */
export async function runMcpAddWizard({
  dialogs,
  servers,
  threadId,
  signal: externalSignal,
}: McpAddWizardOptions): Promise<McpAddWizardResult> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort("MCP server setup timed out."),
    ADD_WIZARD_TIMEOUT_MS,
  );
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutController.signal])
    : timeoutController.signal;
  const dialogContext: DialogHostOpenOptions = { threadId, signal, origin: "app" };
  const portCallOptions = { signal };

  try {
    const transportResult = await dialogs.open(
      {
        kind: "select",
        id: nextDialogId(),
        title: "How should the MCP server connect?",
        options: TRANSPORT_OPTIONS.map((option) => option.label),
        optionDetails: TRANSPORT_OPTIONS.map((option) => ({ description: option.description })),
        timeoutMs: ADD_WIZARD_TIMEOUT_MS,
      },
      dialogContext,
    );
    if (selectionCancelled(transportResult))
      return { status: "cancelled", timedOut: transportResult.timedOut };
    const transportOption = TRANSPORT_OPTIONS.find(
      (option) => option.label === transportResult.response.value,
    );
    if (!transportOption || !McpTransport.safeParse(transportOption.value).success) {
      throw new AppFailure({
        code: "invalid_args",
        message: "Choose a supported MCP server transport.",
        retryable: false,
      });
    }

    const nameResult = await promptValidatedInput(
      dialogs,
      dialogContext,
      "MCP server name",
      "For example: filesystem",
      serverNameInput,
    );
    if (nameResult.status === "cancelled") return nameResult;
    const name = nameResult.value;

    const scopeResult = await dialogs.open(
      {
        kind: "select",
        id: nextDialogId(),
        title: "Where should this MCP server be saved?",
        options: SCOPE_OPTIONS.map((option) => option.label),
        optionDetails: SCOPE_OPTIONS.map((option) => ({ description: option.description })),
        timeoutMs: ADD_WIZARD_TIMEOUT_MS,
      },
      dialogContext,
    );
    if (selectionCancelled(scopeResult))
      return { status: "cancelled", timedOut: scopeResult.timedOut };
    const scope = scopeFromLabel(scopeResult.response.value);
    if (scope === undefined) {
      throw new AppFailure({
        code: "invalid_args",
        message: "Choose a project or user configuration scope.",
        retryable: false,
      });
    }

    let addArgs: McpAddServerArgs;
    if (transportOption.value === "stdio") {
      const commandResult = await promptValidatedInput(
        dialogs,
        dialogContext,
        "Executable for the MCP server",
        "For example: node",
        commandInput,
      );
      if (commandResult.status === "cancelled") return commandResult;
      const command = commandResult.value;
      const argsResult = await dialogs.open(
        {
          kind: "editor",
          id: nextDialogId(),
          title: "Command arguments (one argument per line; do not enter credentials)",
          prefill: "",
        },
        dialogContext,
      );
      if (editorCancelled(argsResult))
        return { status: "cancelled", timedOut: argsResult.timedOut };
      const args = argsResult.response.value
        .split(/\r?\n/)
        .filter((argument) => argument.trim().length > 0);
      addArgs = {
        name,
        scope,
        operationId: crypto.randomUUID(),
        transport: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
      };
    } else {
      const urlResult = await promptValidatedInput(
        dialogs,
        dialogContext,
        "MCP server address",
        "For example: https://mcp.example.test/api/mcp",
        serverUrlInput,
      );
      if (urlResult.status === "cancelled") return urlResult;
      const url = urlResult.value;
      addArgs = {
        name,
        scope,
        operationId: crypto.randomUUID(),
        transport: transportOption.value,
        url,
      };
    }

    const confirmed = await dialogs.confirm(
      {
        kind: "confirm",
        id: nextDialogId(),
        title: "Save this MCP server?",
        message: `Add "${name}" to the ${scope} configuration? The connection test runs after it is saved.`,
        timeoutMs: ADD_WIZARD_TIMEOUT_MS,
      } satisfies ConfirmDialogRequest,
      dialogContext,
    );
    if (!confirmed) return { status: "cancelled" };

    const added = await servers.add(addArgs, portCallOptions);
    if (added.server === null) {
      throw new AppFailure({
        code: "internal",
        message: "omp did not return a summary for the saved MCP server.",
        retryable: true,
        capability: I1_CAPABILITIES.mcp,
      });
    }
    return {
      status: "added",
      server: added.server,
      test: await testAddedServer(servers, added.server, signal),
    };
  } finally {
    clearTimeout(timeout);
  }
}
