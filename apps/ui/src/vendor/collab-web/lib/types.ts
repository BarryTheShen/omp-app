/**
 * The two types the transcript takes from collab-web's guest client (`src/lib/client.ts`), which is not vendored:
 * omp-app feeds the transcript from its own chat store.
 */

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}
