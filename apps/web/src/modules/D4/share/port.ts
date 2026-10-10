import type { AppClient } from "@omp-app/client";
import { AppFailure, OmpCommandGateway, ShareResult, type ThreadId } from "@omp-app/contracts";
import type { SharePort } from "../contract";

/** The typed `/share` call. The server parses omp's reply (A1 issue 793), so browser code never reads command text. */
export interface ShareCommandClient {
  createShare(threadId: ThreadId, signal?: AbortSignal): Promise<unknown>;
}

/** The share call through A1's command gateway: `OmpCommandGateway.share`, which resolves the typed result. */
export function createShareCommandClient(client: Pick<AppClient, "port">): ShareCommandClient {
  const gateway = client.port(OmpCommandGateway);
  return {
    createShare: (threadId, signal) => gateway.share({ threadId }, { signal }),
  };
}

/**
 * D4's `SharePort` over the typed `/share` call. Every result is checked against A1's `ShareResult`
 * contract (https links only, no extra fields). Any other shape is an `internal` failure, and no link is
 * shown: there is no best-effort guess.
 */
export function createSharePort(client: ShareCommandClient): SharePort {
  return {
    async createShare(threadId, signal) {
      let value: unknown;
      try {
        value = await client.createShare(threadId, signal);
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw new AppFailure(
          {
            code: "internal",
            message: "Sharing did not finish for an unexpected reason.",
            retryable: false,
          },
          { cause: error },
        );
      }
      const parsed = ShareResult.safeParse(value);
      if (!parsed.success) {
        throw new AppFailure({
          code: "internal",
          message: "omp returned a share result this app does not recognize, so no link was shown.",
          retryable: false,
        });
      }
      return parsed.data;
    },
  };
}
