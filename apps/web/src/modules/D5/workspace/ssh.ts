import { AppFailure, SlashCommand, type ThreadId } from "@omp-app/contracts";
import { type SessionCommandOutcome, type SshHost, SshHost as SshHostSchema } from "../contract";
import {
  confirmWorkspaceAction,
  promptOptionalWorkspaceText,
  promptWorkspaceChoice,
  promptWorkspaceText,
  type WorkspaceDialogs,
} from "./dialogs";

const SSH_ACTIONS = ["List hosts", "Add host", "Remove host", "Show help"] as const;
const SSH_SCOPES = ["Project", "Global"] as const;

export interface SshCommandIntent {
  readonly label: string;
  readonly command: ReturnType<typeof SlashCommand.parse>;
}

function invalid(message: string): SessionCommandOutcome<never> {
  return { status: "error", error: { code: "invalid_args", message, retryable: false } };
}

function isSafeValue(value: string): boolean {
  return !/[\r\n\0"]/.test(value);
}

function quoted(value: string): string {
  if (!isSafeValue(value)) {
    throw new AppFailure({
      code: "invalid_args",
      message: "SSH values cannot contain quotes or line breaks.",
      retryable: false,
    });
  }
  return `"${value}"`;
}

function addCommand(host: SshHost): SshCommandIntent {
  const args = ["/ssh add", quoted(host.name), "--host", quoted(host.host)];
  if (host.user) args.push("--user", quoted(host.user));
  if (host.port !== undefined) args.push("--port", String(host.port));
  if (host.keyLabel) args.push("--key", quoted(host.keyLabel));
  args.push("--scope", host.scope === "global" ? "user" : "project");
  return { label: "Add SSH host", command: SlashCommand.parse(args.join(" ")) };
}

export async function requestSshCommand(
  dialogs: WorkspaceDialogs,
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<SessionCommandOutcome<SshCommandIntent>> {
  const action = await promptWorkspaceChoice(
    dialogs,
    threadId,
    "SSH hosts",
    SSH_ACTIONS,
    "ssh-action",
    signal,
  );
  if (action.status !== "completed") return action;
  switch (action.value) {
    case "List hosts":
      return {
        status: "completed",
        value: { label: "SSH hosts", command: SlashCommand.parse("/ssh list") },
      };
    case "Show help":
      return {
        status: "completed",
        value: { label: "SSH help", command: SlashCommand.parse("/ssh help") },
      };
    case "Add host":
      return addSshHost(dialogs, threadId, signal);
    case "Remove host":
      return removeSshHost(dialogs, threadId, signal);
  }
}

async function addSshHost(
  dialogs: WorkspaceDialogs,
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<SessionCommandOutcome<SshCommandIntent>> {
  const name = await promptWorkspaceText(
    dialogs,
    threadId,
    "SSH host name",
    "build-server",
    "ssh-name",
    signal,
  );
  if (name.status !== "completed") return name;
  const host = await promptWorkspaceText(
    dialogs,
    threadId,
    "SSH host address",
    "build.example.com",
    "ssh-host",
    signal,
  );
  if (host.status !== "completed") return host;
  const user = await promptOptionalWorkspaceText(
    dialogs,
    threadId,
    "SSH user",
    "User name",
    "ssh-user",
    signal,
  );
  if (user.status !== "completed") return user;
  const port = await promptOptionalWorkspaceText(
    dialogs,
    threadId,
    "SSH port",
    "22",
    "ssh-port",
    signal,
  );
  if (port.status !== "completed") return port;
  const keyPath = await promptOptionalWorkspaceText(
    dialogs,
    threadId,
    "Identity file path on the omp host",
    "~/.ssh/id_ed25519",
    "ssh-key-path",
    signal,
  );
  if (keyPath.status !== "completed") return keyPath;
  const scope = await promptWorkspaceChoice(
    dialogs,
    threadId,
    "SSH config scope",
    SSH_SCOPES,
    "ssh-scope",
    signal,
  );
  if (scope.status !== "completed") return scope;

  const userValue = user.value ?? "";
  const portValue = port.value ?? "";
  const keyLabel = keyPath.value ?? "";
  if (![name.value, host.value, userValue, keyLabel].every(isSafeValue)) {
    return invalid("SSH values cannot contain quotes or line breaks.");
  }
  if (portValue.trim() && !/^\d+$/.test(portValue.trim())) {
    return invalid("SSH port must be an integer between 1 and 65535.");
  }
  const parsed = SshHostSchema.safeParse({
    name: name.value,
    host: host.value,
    ...(userValue.trim() ? { user: userValue } : {}),
    ...(portValue.trim() ? { port: Number(portValue) } : {}),
    ...(keyLabel.trim() ? { keyLabel } : {}),
    scope: scope.value === "Global" ? "global" : "project",
  });
  if (!parsed.success) return invalid("Enter a valid SSH host, port, user and scope.");
  return { status: "completed", value: addCommand(parsed.data) };
}

async function removeSshHost(
  dialogs: WorkspaceDialogs,
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<SessionCommandOutcome<SshCommandIntent>> {
  const name = await promptWorkspaceText(
    dialogs,
    threadId,
    "SSH host name to remove",
    "build-server",
    "ssh-remove",
    signal,
  );
  if (name.status !== "completed") return name;
  const scope = await promptWorkspaceChoice(
    dialogs,
    threadId,
    "SSH config scope",
    SSH_SCOPES,
    "ssh-remove-scope",
    signal,
  );
  if (scope.status !== "completed") return scope;
  if (!isSafeValue(name.value))
    return invalid("SSH host names cannot contain quotes or line breaks.");
  const confirmed = await confirmWorkspaceAction(
    dialogs,
    threadId,
    "Remove SSH host?",
    `Remove ${name.value} from the ${scope.value.toLocaleLowerCase()} SSH config?`,
    "ssh-remove-confirm",
    signal,
  );
  if (confirmed.status !== "completed") return confirmed;
  if (!confirmed.value) return { status: "cancelled" };
  const scopeName = scope.value === "Global" ? "user" : "project";
  return {
    status: "completed",
    value: {
      label: "Remove SSH host",
      command: SlashCommand.parse(`/ssh remove ${quoted(name.value)} --scope ${scopeName}`),
    },
  };
}
