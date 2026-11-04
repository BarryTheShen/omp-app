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

/** The text of a message's content: a string, or its text blocks joined by lines. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			const block = asRecord(part);
			return block?.type === "text" ? (textOf(block.text) ?? "") : "";
		})
		.filter(text => text !== "")
		.join("\n");
}

/** omp's text without the tag it wraps it in for the model (`<irc>…</irc>`, `<system-notice>…</system-notice>`). */
export function withoutWrapper(text: string): string {
	const match = /^\s*<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>\s*$/i.exec(text);
	return match?.[2] ?? text.trim();
}

/** A process a launch supervised and that has ended, as omp's terminal writes it (`buildLaunchCompletionBlock`). */
export interface ProcessRow {
	readonly tone: "ok" | "err";
	readonly text: string;
	readonly name: string;
	readonly exit?: number;
	readonly duration?: string;
}

/**
 * omp-app's addition (#2827): one of omp's other messages it shows, as its terminal and the old UI drew it, from the
 * message's details, not from the text omp gives the model (the `<irc>` envelope and how to answer, a tag around a
 * notice): who wrote an IRC message and what it says, the advisor's notes, the processes a launch ended, a tangent sent
 * to a background job. A kind this does not know keeps its type as a chip and its text, without omp's tag.
 */
export interface NoticeView {
	readonly known: boolean;
	readonly heading?: string;
	readonly rows: readonly ProcessRow[];
	/** Markdown under the heading. */
	readonly body: string;
}

/** omp's cut for a tangent's work (`packages/tui/src/chat/background-tan-message.ts`): 56 characters, an ellipsis last. */
const TANGENT_PREVIEW = 56;

export function describeNotice(customType: string, details: unknown, text: string): NoticeView {
	const record = asRecord(details);
	const said = (key: string): string | undefined => textOf(record?.[key])?.trim() || undefined;
	const note = (heading: string, body: string): NoticeView => ({ known: true, heading, rows: [], body });
	switch (customType) {
		case "irc:incoming": {
			const from = said("from");
			return note(
				from === undefined ? "Message from another agent" : `Message from ${from}`,
				said("message") ?? withoutWrapper(text),
			);
		}
		case "irc:autoreply": {
			const to = said("to");
			return note(to === undefined ? "Automatic reply" : `Automatic reply to ${to}`, said("body") ?? withoutWrapper(text));
		}
		case "irc:relay":
			return note(
				`Message from ${said("from") ?? "an agent"} to ${said("to") ?? "another agent"}`,
				said("body") ?? withoutWrapper(text),
			);
		case "irc:workpool": {
			const mode = said("mode");
			const heading = `Pool ${said("pool") ?? "?"} to ${said("to") ?? "?"}`;
			return note(mode === undefined ? heading : `${heading} (${mode})`, said("body") ?? withoutWrapper(text));
		}
		case "advisor": {
			const notes = Array.isArray(record?.notes)
				? record.notes.flatMap(each => {
						const line = textOf(asRecord(each)?.note);
						return line === undefined ? [] : [line];
					})
				: [];
			return note("Advisor note", notes.length > 0 ? notes.join("\n\n") : withoutWrapper(text));
		}
		case "launch-completion": {
			const rows = (Array.isArray(record?.daemons) ? record.daemons : []).flatMap(each => {
				const daemon = asRecord(each);
				if (daemon === undefined) return [];
				const exit = typeof daemon.exitCode === "number" ? daemon.exitCode : undefined;
				const failed = daemon.state === "failed" || (exit !== undefined && exit !== 0);
				const ran =
					typeof daemon.startedAt === "number" && typeof daemon.exitedAt === "number"
						? daemon.exitedAt - daemon.startedAt
						: undefined;
				const row: ProcessRow = {
					tone: failed ? "err" : "ok",
					text: failed ? "Supervised process failed" : "Supervised process completed",
					name: textOf(daemon.name) ?? "process",
					...(exit === undefined ? {} : { exit }),
					...(ran === undefined ? {} : { duration: fmtDuration(ran) }),
				};
				return [row];
			});
			return rows.length > 0
				? { known: true, rows, body: "" }
				: note("Process finished", withoutWrapper(text));
		}
		case "background-tan-dispatch": {
			const jobId = said("jobId");
			const work = textOf(record?.work)?.replace(/\s+/g, " ").trim() ?? "";
			const preview = work.length <= TANGENT_PREVIEW ? work : `${work.slice(0, TANGENT_PREVIEW - 1)}…`;
			const job = jobId === undefined ? "a background job" : `background job ${jobId}`;
			return note(preview === "" ? `Tangent sent to ${job}` : `Tangent sent to ${job}: ${preview}`, withoutWrapper(text));
		}
		default:
			return { known: false, rows: [], body: withoutWrapper(text) };
	}
}
