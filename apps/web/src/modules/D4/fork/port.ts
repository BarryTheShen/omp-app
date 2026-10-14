import type { AppClient } from "@omp-app/client";
import { AppFailure, type FolderPath, SessionImportPort } from "@omp-app/contracts";
import { parseShareImportResult, type ShareImportResultDto } from "../contract";

/** A1.12's `SessionImportPort.import` call, as the app client exposes it. */
export interface ShareImportClient {
  import(
    args: {
      readonly sourceKind: "omp-share";
      readonly sourceRef: string;
      readonly folder: FolderPath;
    },
    options: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
}

export function createShareImportClient(client: Pick<AppClient, "port">): ShareImportClient {
  return client.port(SessionImportPort);
}

/** D4's import of one share link into a new local chat. The result never carries omp's file path or the source URL. */
export interface ShareImportPort {
  importShare(
    sourceRef: string,
    folder: FolderPath,
    signal?: AbortSignal,
  ): Promise<ShareImportResultDto>;
}

/**
 * The typed import over A1.12. A result that does not match A1.12's shape is an `internal` failure, and no chat is
 * opened: there is no best-effort guess.
 */
export function createShareImportPort(client: ShareImportClient): ShareImportPort {
  return {
    async importShare(sourceRef, folder, signal) {
      let value: unknown;
      try {
        value = await client.import({ sourceKind: "omp-share", sourceRef, folder }, { signal });
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw new AppFailure(
          {
            code: "internal",
            message: "The shared chat could not be imported for an unexpected reason.",
            retryable: false,
          },
          { cause: error },
        );
      }
      try {
        return parseShareImportResult(value);
      } catch (error) {
        throw new AppFailure(
          {
            code: "internal",
            message:
              "omp returned an import result this app does not recognize, so no chat was opened.",
            retryable: false,
          },
          { cause: error },
        );
      }
    },
  };
}
