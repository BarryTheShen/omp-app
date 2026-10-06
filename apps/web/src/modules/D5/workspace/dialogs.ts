import { AppFailure, type ThreadId, UiRequestId } from "@omp-app/contracts";
import type { ConfirmDialogRequest, SelectOptionDetail } from "../../U4/contract/dialog";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type { SessionCommandOutcome } from "../contract";

export type WorkspaceDialogs = Pick<DialogHost, "open" | "confirm">;

function requestId(name: string) {
  return UiRequestId.parse(`app-d5-workspace-${name}-${crypto.randomUUID()}`);
}

function openOptions(threadId: ThreadId, signal?: AbortSignal) {
  return signal === undefined
    ? { threadId, origin: "app" as const }
    : { threadId, origin: "app" as const, signal };
}

function dialogFailure<Value>(cause: unknown, fallback: string): SessionCommandOutcome<Value> {
  if (cause instanceof AppFailure) {
    if (cause.appError.code === "cancelled") return { status: "cancelled" };
    return {
      status: cause.appError.code === "unavailable" ? "unavailable" : "error",
      error: cause.appError,
    };
  }
  return { status: "error", error: { code: "internal", message: fallback, retryable: true } };
}

function unexpected<Value>(message: string): SessionCommandOutcome<Value> {
  return { status: "error", error: { code: "invalid_args", message, retryable: false } };
}

function isOption<const Option extends string>(
  options: readonly Option[],
  value: string,
): value is Option {
  return options.some((option) => option === value);
}

export async function promptWorkspaceText(
  dialogs: WorkspaceDialogs,
  threadId: ThreadId,
  title: string,
  placeholder: string,
  id: string,
  signal?: AbortSignal,
): Promise<SessionCommandOutcome<string>> {
  try {
    const result = await dialogs.open(
      { kind: "input", id: requestId(id), title, placeholder },
      openOptions(threadId, signal),
    );
    if (result.outcome === "cancelled") return { status: "cancelled" };
    if (result.response.kind !== "input")
      return unexpected("The text input dialog returned an unexpected result.");
    return { status: "completed", value: result.response.value };
  } catch (cause) {
    return dialogFailure(cause, "The text input dialog failed.");
  }
}

export async function promptWorkspaceChoice<const Option extends string>(
  dialogs: WorkspaceDialogs,
  threadId: ThreadId,
  title: string,
  options: readonly Option[],
  id: string,
  signal?: AbortSignal,
  optionDetails?: readonly SelectOptionDetail[],
): Promise<SessionCommandOutcome<Option>> {
  try {
    const result = await dialogs.open(
      {
        kind: "select",
        id: requestId(id),
        title,
        options: [...options],
        ...(optionDetails === undefined ? {} : { optionDetails: [...optionDetails] }),
      },
      openOptions(threadId, signal),
    );
    if (result.outcome === "cancelled") return { status: "cancelled" };
    if (result.response.kind !== "select" || !isOption(options, result.response.value)) {
      return unexpected("The choice dialog returned an unexpected result.");
    }
    return { status: "completed", value: result.response.value };
  } catch (cause) {
    return dialogFailure(cause, "The choice dialog failed.");
  }
}

/** One optional text dialog: a blank answer means the user skipped the field. */
export async function promptOptionalWorkspaceText(
  dialogs: WorkspaceDialogs,
  threadId: ThreadId,
  title: string,
  placeholder: string,
  id: string,
  signal?: AbortSignal,
): Promise<SessionCommandOutcome<string | null>> {
  try {
    const result = await dialogs.open(
      {
        kind: "input",
        id: requestId(id),
        title: `${title} (optional)`,
        placeholder,
        optional: true,
      },
      openOptions(threadId, signal),
    );
    if (result.outcome === "cancelled") return { status: "cancelled" };
    if (result.response.kind !== "input")
      return unexpected("The text input dialog returned an unexpected result.");
    return {
      status: "completed",
      value: result.response.value === "" ? null : result.response.value,
    };
  } catch (cause) {
    return dialogFailure(cause, "The text input dialog failed.");
  }
}

export async function confirmWorkspaceAction(
  dialogs: WorkspaceDialogs,
  threadId: ThreadId,
  title: string,
  message: string,
  id: string,
  signal?: AbortSignal,
): Promise<SessionCommandOutcome<boolean>> {
  try {
    return {
      status: "completed",
      value: await dialogs.confirm(
        { kind: "confirm", id: requestId(id), title, message } satisfies ConfirmDialogRequest,
        openOptions(threadId, signal),
      ),
    };
  } catch (cause) {
    return dialogFailure(cause, "The confirmation dialog failed.");
  }
}
