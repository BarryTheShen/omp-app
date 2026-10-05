import type { SessionLeaseProbe, SessionLeaseState } from "./types";

export interface SessionLivenessProbeResult {
  readonly lease: SessionLeaseState;
}

/**
 * Ask an injected bridge to probe omp's process-owned session lease. A free
 * lease is immediately released; the adapter never leaves a probe lease held.
 * Without a bridge the result is explicitly unknown rather than inferred from
 * a transcript mtime or the short-lived `.lock` publication file.
 */
export async function detectSessionLiveness(
  sessionId: string,
  sessionFile: string,
  leaseProbe?: SessionLeaseProbe,
): Promise<SessionLivenessProbeResult> {
  if (!leaseProbe) return { lease: "unknown" };

  try {
    const result = await leaseProbe(sessionId, sessionFile);
    if (typeof result === "function") {
      result();
      return { lease: "free" };
    }
    if (result === null || result === true || result === "active") return { lease: "held" };
    if (result === false || result === "inactive") return { lease: "free" };
    return { lease: "unknown" };
  } catch {
    return { lease: "unknown" };
  }
}
