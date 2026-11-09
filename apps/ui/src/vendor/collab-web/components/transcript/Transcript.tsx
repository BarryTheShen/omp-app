import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { Check, ChevronRight, Eye, FileText, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FoldContext } from "../../lib/fold";
import type { ActiveTool, ConnectionPhase } from "../../lib/types";
import { fmtTokens } from "../../lib/format";
import { type SentFile, type SentHostContext, splitAttached, splitHostContext } from "@omp-app/contracts";
import { contentText, deliveredText, describeNotice, jobRows } from "../../lib/notices";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

export function Row({
	kind,
	gutter,
	title,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	// omp-app: a pane's Alt+T shows or hides every thinking block; one drawn later starts as the last request said.
	const fold = useContext(FoldContext).thinking;
	const [open, setOpen] = useState(fold.epoch > 0 && fold.open);
	useEffect(() => {
		if (fold.epoch > 0) setOpen(fold.open);
	}, [fold.epoch, fold.open]);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/**
 * omp-app: a background job that finished, as omp's terminal draws it (`buildAsyncResultBlock`): one row per job, and the
 * row folds out what the job delivered (omp hands that text to the model, so the terminal does not show it).
 */
function JobNotice({ details, content }: { details: unknown; content: unknown }): ReactNode {
	const fold = useContext(FoldContext).tools;
	const [open, setOpen] = useState(fold.epoch > 0 && fold.open);
	useEffect(() => {
		if (fold.epoch > 0) setOpen(fold.open);
	}, [fold.epoch, fold.open]);
	const delivered = deliveredText(content);
	return (
		<div className="tr-job" data-custom-type="async-result">
			<button type="button" className="tr-job-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				<span className="tr-job-rows">
					{jobRows(details).map(row => (
						<span key={row.jobId} className={`tr-job-row tr-job-row--${row.tone}`}>
							{row.tone === "err" ? <X size={12} aria-hidden /> : <Check size={12} aria-hidden />}
							{/* The spaces are for the button's name; the row's gap lays the parts out. */}
							<span className="tr-job-text">{row.text}</span>{" "}
							<span className="tr-job-dim">[{row.type}]</span>{" "}
							<span className="tr-job-id">{row.jobId}</span>
							{row.duration !== undefined && <> <span className="tr-job-dim">({row.duration})</span></>}
						</span>
					))}
				</span>
			</button>
			{open && delivered !== "" && <pre className="tr-job-body">{delivered}</pre>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

type UserContent = string | readonly (TextContent | ImageContent)[];

/**
 * omp-app: the files a message names (`lib/attached.ts`, #2830) and what was open in the app that embeds the panel
 * (`withHostContext`), taken off its last text, and the message without them.
 */
function withoutAdded(content: UserContent): {
	content: UserContent;
	files: readonly SentFile[];
	context: SentHostContext | null;
} {
	const split = (message: string) => {
		const { text: rest, context } = splitHostContext(message);
		return { ...splitAttached(rest), context };
	};
	if (typeof content === "string") {
		const { text, files, context } = split(content);
		return { content: text, files, context };
	}
	const last = content.findLastIndex(block => block.type === "text");
	const block = content[last];
	if (block?.type !== "text") return { content, files: [], context: null };
	const { text, files, context } = split(block.text);
	if (files.length === 0 && context === null) return { content, files, context };
	return {
		content:
			text === ""
				? content.filter((_, index) => index !== last)
				: content.map((part, index) => (index === last ? { ...block, text } : part)),
		files,
		context,
	};
}

/** omp-app: what was open in the app that embeds the panel when the message was sent, as one chip; its address in a tip. */
function SentContext({ context }: { context: SentHostContext }): ReactNode {
	const what = context.selection === undefined ? context.title : `${context.title} (a selection)`;
	return (
		<ul className="tr-files" aria-label={`Sent with what was open in ${context.host}`}>
			<li>
				<span className="tr-file tr-context" title={context.uri ?? context.title}>
					<Eye size={14} aria-hidden />
					<span className="tr-file-name">{what}</span>
				</span>
			</li>
		</ul>
	);
}

/** omp-app: a sent message's files, one chip each; a chip downloads its file to this device where the host can. */
function AttachedFiles({ files, host }: { files: readonly SentFile[]; host?: ToolRenderHost }): ReactNode {
	const download = host?.downloadAttachment;
	return (
		<ul className="tr-files" aria-label="Attached files">
			{files.map(file => (
				<li key={file.name}>
					<button
						type="button"
						className="tr-file"
						disabled={download === undefined}
						aria-label={download === undefined ? file.name : `Download ${file.name}`}
						title={download === undefined ? undefined : "Download"}
						onClick={() => download?.(file.name)}
					>
						<FileText size={14} aria-hidden />
						<span className="tr-file-name">{file.name}</span>
						<span className="tr-file-size">{file.size}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/** omp's mark on a reply it stopped itself (pi-tui `SILENT_ABORT_MARKER`), as when a plan's review opens. */
const SILENT_ABORT_MARKER = "__omp.silent_abort__";
/** The same in the reply's error id: pi-ai's `AIError.Flag.SilentAbort` bit, which the wire's type leaves out. */
const SILENT_ABORT_FLAG = 0x0200_0000;

/** omp-app: a reply omp stopped itself is no failure to show (omp's `isSilentAbort`, pi-tui `chat/messages.ts`). */
export function silentAbort(message: AssistantMessage): boolean {
	const errorId = (message as AssistantMessage & { readonly errorId?: number }).errorId ?? 0;
	return message.errorMessage === SILENT_ABORT_MARKER || (errorId & SILENT_ABORT_FLAG) !== 0;
}

export function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return pending ? <StreamingMarkdown key={i} text={block.text} /> : <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted") && !silentAbort(message);
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

/**
 * omp-app: a message omp shows (`display`), drawn the same from the file (`custom_message`) and from the live stream
 * (a `custom` message, before the file holds it): a finished background job as omp's row, the others from their details
 * as omp's terminal and the old UI drew them (#2827): an IRC message as who wrote it and what it says, not the envelope
 * omp gives the model. A kind it does not know shows its type and its text, without omp's tag.
 */
function CustomBody({
	customType,
	details,
	content,
}: {
	customType: string;
	details: unknown;
	content: string | readonly (TextContent | ImageContent)[];
}): ReactNode {
	if (customType === "async-result") return <JobNotice details={details} content={content} />;
	const note = describeNotice(customType, details, contentText(content));
	const images = typeof content === "string" ? [] : content.filter(block => block.type === "image");
	return (
		<div className="tr-custom" data-custom-type={customType}>
			{!note.known && <span className="tr-chip">{customType}</span>}
			{note.heading !== undefined && <span className="tr-note-head">{note.heading}</span>}
			{note.rows.length > 0 && (
				<span className="tr-job-rows">
					{note.rows.map((row, i) => (
						<span key={i} className={`tr-job-row tr-job-row--${row.tone}`}>
							{row.tone === "err" ? <X size={12} aria-hidden /> : <Check size={12} aria-hidden />}
							<span className="tr-job-text">{row.text}</span> <span className="tr-job-id">{row.name}</span>
							{row.exit !== undefined && <> <span className="tr-job-dim">(exit {row.exit})</span></>}
							{row.duration !== undefined && <> <span className="tr-job-dim">({row.duration})</span></>}
						</span>
					))}
				</span>
			)}
			{note.body !== "" && <Markdown text={note.body} />}
			{images.length > 0 && <MsgContent content={images} />}
		</div>
	);
}

export const EntryRow = memo(function EntryRow({ entry, results, active, host }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			// omp-app: `custom` is omp's own message kind, which the wire's role list does not name.
			switch (msg.role as string) {
				case "user": {
					// omp-app: the files a message names (#2830) are drawn as chips under its text, not as the paragraph; so is
					// what was open in the app that embeds the panel.
					const { content, files, context } = withoutAdded(
						(msg as Extract<typeof msg, { role: "user" }>).content,
					);
					return (
						<Row kind="user" gutter="host" title={entry.timestamp}>
							<MsgContent content={content} />
							{files.length > 0 && <AttachedFiles files={files} host={host} />}
							{context !== null && <SentContext context={context} />}
						</Row>
					);
				}
				case "assistant":
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp}>
							<AssistantBody
								message={msg as AssistantMessage}
								results={results}
								active={active}
								pending={false}
								host={host}
							/>
						</Row>
					);
				case "custom": {
					const custom = msg as unknown as {
						customType: string;
						display?: boolean;
						details?: unknown;
						content: string | readonly (TextContent | ImageContent)[];
					};
					if (custom.display !== true) return null;
					return (
						<Row kind="custom" gutter="" title={entry.timestamp}>
							<CustomBody customType={custom.customType} details={custom.details} content={custom.content} />
						</Row>
					);
				}
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row kind="user" gutter={<span className="tr-badge">{from}</span>} title={entry.timestamp}>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<CustomBody customType={entry.customType} details={entry.details} content={entry.content} />
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, phase } = props;

	// null follows the tail. A number pins the first mounted entry while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them.
	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	/**
	 * First visible row and its offset from the viewport top, captured before
	 * mounting earlier rows. Restoring against the row, not the total height
	 * delta, stays exact when the same commit also appends live entries.
	 */
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [start]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (row.classList.contains("tr-earlier")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
		setPinnedStart(Math.max(0, start - WINDOW));
	};

	// Tool calls committed anywhere in the session: rescanned when entries change,
	// not per streaming token or tool output update.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				updateTranscriptTailLock(el, lockRef);
				// Back at the bottom: drop the pin so the window trims to the tail again.
				if (lockRef.current) {
					if (pinnedStart !== null) setPinnedStart(null);
				} else if (pinnedStart === null) {
					setPinnedStart(start);
				}
				if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">no activity yet</div>
			)}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={showEarlier}>
					show {start.toLocaleString("en-US")} earlier
				</button>
			)}
			{visible.map(entry => (
				<EntryRow key={entry.id} entry={entry} results={results} active={activeTools} host={host} />
			))}
			{stream !== null && (
				<Row kind="assistant" gutter="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
		</div>
	);
}
