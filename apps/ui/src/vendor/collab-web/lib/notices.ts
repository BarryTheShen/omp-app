import { fmtDuration } from "./format";

/**
 * omp-app's addition: what the transcript draws for omp's `async-result` message (a background job, or a batch of
 * them, that finished), as omp's terminal does (`pi-tui/src/chat/transcript-render-helpers.ts`, `buildAsyncResultBlock`):
 * one row per job with its type, id and how long it ran, instead of the text omp delivered to the model.
 */
export interface JobRow {
	readonly tone: "ok" | "err" | "muted";
	/** omp's words: "Background job completed", or "failed" / "cancelled" when the job says so. */
	readonly text: string;
	readonly type: string;
	readonly jobId: string;
	/** How long it ran, as the transcript writes durations; absent when omp did not say. */
	readonly duration?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const textOf = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

const ENDED: Record<string, Pick<JobRow, "tone" | "text">> = {
	failed: { tone: "err", text: "Background job failed" },
	cancelled: { tone: "muted", text: "Background job cancelled" },
};

/** One row per job: a batch lists them in `jobs`; an older delivery puts one job's fields on the details. */
export function jobRows(details: unknown): JobRow[] {
	const record = asRecord(details);
	const listed = Array.isArray(record?.jobs)
		? record.jobs.flatMap(job => {
				const each = asRecord(job);
				return each === undefined ? [] : [each];
			})
		: [];
	const jobs = listed.length > 0 ? listed : [record ?? {}];
	return jobs.map(job => {
		const said = ENDED[textOf(job.status) ?? ""] ?? { tone: "ok", text: "Background job completed" };
		const ms = job.durationMs;
		return {
			...said,
			type: textOf(job.type) ?? "job",
			jobId: textOf(job.jobId) ?? "unknown",
			...(typeof ms === "number" && Number.isFinite(ms) ? { duration: fmtDuration(ms) } : {}),
		};
	});
}

/**
 * What omp delivered for the jobs, for the row to fold out: the text inside omp's `<system-notice>`, without its first
 * line, which tells the model to go on.
 */
export function deliveredText(content: unknown): string {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map(part => {
							const block = asRecord(part);
							return block?.type === "text" ? (textOf(block.text) ?? "") : "";
						})
						.join("\n")
				: "";
	const inner = text.replace(/^\s*<system-notice>\s*/, "").replace(/\s*<\/system-notice>\s*$/, "");
	const lines = inner.split("\n");
	if (lines[0]?.startsWith("Background job")) lines.shift();
	return lines.join("\n").trim();
}
