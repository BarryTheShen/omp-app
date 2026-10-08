import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type {
  CapabilityKey,
  SessionImportArgs,
  SessionImportResult,
  SessionPinSetArgs,
  SessionPinSetResult,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, UiRequestId as UiRequestIdSchema } from "@omp-app/contracts";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type { SessionMetadata } from "../contract";

export interface SessionMutationAdapter {
  rename(remoteId: string, newTitle: string): Promise<void>;
  delete(remoteId: string): Promise<void>;
}

export interface SessionPinClient {
  set(args: SessionPinSetArgs): Promise<SessionPinSetResult>;
}

export interface SessionImportClient {
  import(args: SessionImportArgs): Promise<SessionImportResult>;
}

export type SessionActionOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable" | "error"; readonly error: AppFailure };

export interface ActionAvailability {
  readonly state: "available" | "unavailable";
  readonly capability?: string;
  readonly reason?: string;
}

export const SESSION_IMPORT_UNAVAILABLE: ActionAvailability = Object.freeze({
  state: "unavailable",
  capability: "upstream.session-import",
  reason: "The running omp does not expose a non-interactive session import operation.",
});

export interface SessionActionsOptions {
  readonly remote: SessionMutationAdapter | Pick<RemoteThreadListAdapter, "rename" | "delete">;
  readonly pins?: SessionPinClient;
  readonly imports?: SessionImportClient;
  readonly dialogs?: DialogHost;
  readonly threadId: ThreadId;
}

/** R1.7's mutation seam: all destructive/foreign-session work remains typed and host-owned. */
export class SessionActionsController {
  private readonly options: SessionActionsOptions;

  public constructor(options: SessionActionsOptions) {
    this.options = options;
  }

  public getPinAvailability(): ActionAvailability {
    return this.options.pins
      ? { state: "available", capability: "host.session-pins" }
      : {
          state: "unavailable",
          capability: "host.session-pins",
          reason: "Pinning is unavailable for this connection.",
        };
  }

  public getImportAvailability(): ActionAvailability {
    return this.options.imports
      ? { state: "available", capability: "host.session-import" }
      : SESSION_IMPORT_UNAVAILABLE;
  }

  public async rename(
    session: Pick<SessionMetadata, "id">,
    title: string,
  ): Promise<SessionActionOutcome<void>> {
    try {
      await this.options.remote.rename(session.id, title);
      return { status: "completed", value: undefined };
    } catch (error) {
      return this.failure(error, "Renaming the session failed");
    }
  }

  public async delete(
    session: Pick<SessionMetadata, "id" | "title">,
    confirmationId: string = `app-delete-${session.id}`,
  ): Promise<SessionActionOutcome<void>> {
    if (this.options.dialogs === undefined) {
      return {
        status: "unavailable",
        error: unavailable("host.dialogs", "Deleting a session requires a confirmation dialog."),
      };
    }
    try {
      const appConfirmationId = confirmationId.startsWith("app-")
        ? confirmationId
        : `app-${confirmationId}`;
      const confirmed = await this.options.dialogs.confirm(
        {
          kind: "confirm",
          id: UiRequestIdSchema.parse(appConfirmationId),
          title: "Delete session",
          message: `Delete ${session.title ?? session.id}? omp will remove only this native session.`,
        },
        { threadId: this.options.threadId, origin: "app" },
      );
      if (!confirmed) return { status: "cancelled" };
      await this.options.remote.delete(session.id);
      return { status: "completed", value: undefined };
    } catch (error) {
      return this.failure(error, "Deleting the session failed");
    }
  }

  public async setPinned(
    sessionId: ThreadId,
    pinned: boolean,
    expectedRevision: string | null,
  ): Promise<SessionActionOutcome<SessionPinSetResult>> {
    if (this.options.pins === undefined) {
      return {
        status: "unavailable",
        error: unavailable("host.session-pins", "Pinning is unavailable for this connection."),
      };
    }
    try {
      const result = await this.options.pins.set({ sessionId, pinned, expectedRevision });
      return { status: "completed", value: result };
    } catch (error) {
      return this.failure(error, "Updating the session pin failed");
    }
  }

  public async importForeign(
    args: SessionImportArgs,
  ): Promise<SessionActionOutcome<SessionImportResult>> {
    if (this.options.imports === undefined) {
      return {
        status: "unavailable",
        error: unavailable("upstream.session-import", SESSION_IMPORT_UNAVAILABLE.reason as string),
      };
    }
    try {
      const result = await this.options.imports.import(args);
      return { status: "completed", value: result };
    } catch (error) {
      return this.failure(error, "Importing the foreign session failed");
    }
  }

  private failure(error: unknown, fallback: string): SessionActionOutcome<never> {
    const failure =
      error instanceof AppFailure
        ? error
        : new AppFailure(
            {
              code: "internal",
              message: error instanceof Error ? error.message : fallback,
              retryable: true,
            },
            { cause: error },
          );
    return {
      status: failure.appError.code === "unavailable" ? "unavailable" : "error",
      error: failure,
    };
  }
}

function unavailable(capability: CapabilityKey, message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false, capability });
}
