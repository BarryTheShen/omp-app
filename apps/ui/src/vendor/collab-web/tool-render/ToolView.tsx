/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD, toolIntentLabel } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useContext, useEffect, useState } from "react";
import { FoldContext } from "../lib/fold";
import { resolveToolRenderer } from "./registry";
import type { ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord, replaceTabs, stripAnsi } from "./util";
import "./tool-render.css";

export interface ToolViewProps {
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	defaultOpen?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
}

/** A call's arguments without the model's intent (`i`), and that intent. */
export function normalizeArgs(raw: unknown): { args: Record<string, unknown>; intent: string | undefined } {
	if (!isRecord(raw)) return { args: {}, intent: undefined };
	const intent = typeof raw[INTENT_FIELD] === "string" ? (raw[INTENT_FIELD] as string).trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

/**
 * omp-app: a `write` to `xd://<tool>`, as chats from before omp 19.1 hold them; its card is the inner tool's. omp 19.1
 * runs those tools as `bash` commands instead (`toolCommandRecords`), and collab-web dropped this unwrap.
 */
interface XdevDispatch {
	tool: string;
	args: Record<string, unknown>;
	inner: unknown;
}

function executeXdevDispatch(props: ToolViewProps): XdevDispatch | null {
	if (props.name !== "write" || props.result?.isError === true || !isRecord(props.result?.details)) return null;
	const xdev = props.result.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string") return null;
	return { tool: xdev.tool, args: isRecord(xdev.args) ? xdev.args : {}, inner: xdev.inner };
}

/** One tool-command invocation nested in a completed `bash` result. */
interface ToolCommandRecord {
	tool: string;
	mode: "help" | "execute";
	exitCode: number;
	args?: Record<string, unknown>;
	inner?: unknown;
}

/** `details.toolCommands` records of a bash result, in invocation order. */
function toolCommandRecords(result: ToolResultLike | undefined): ToolCommandRecord[] {
	if (!result || !isRecord(result.details)) return [];
	const raw = result.details.toolCommands;
	if (!Array.isArray(raw)) return [];
	const records: ToolCommandRecord[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const { tool, mode, exitCode } = item;
		if (typeof tool !== "string" || typeof exitCode !== "number") continue;
		if (mode !== "help" && mode !== "execute") continue;
		records.push({
			tool,
			mode,
			exitCode,
			args: isRecord(item.args) ? item.args : undefined,
			inner: item.inner,
		});
	}
	return records;
}

/**
 * omp-app: how long a running tool's output must have been there before its box shows. A tool that prints and ends at
 * once flashed the box (up to its 160 px) for a frame or two, and a view following the chat's end jumped down and back.
 */
const PARTIAL_DELAY_MS = 300;

/** omp-app: true once `on` has stayed true for `delayMs`; false again as soon as it turns false. */
function useShownAfter(on: boolean, delayMs: number): boolean {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!on) {
			setShown(false);
			return;
		}
		const timer = setTimeout(() => setShown(true), delayMs);
		return () => clearTimeout(timer);
	}, [on, delayMs]);
	return on && shown;
}

export function ToolView(props: ToolViewProps): ReactNode {
	// omp-app: a pane's Alt+O opens or folds every card; a card drawn later starts as the last request said.
	const fold = useContext(FoldContext).tools;
	const [open, setOpen] = useState(fold.epoch > 0 ? fold.open : (props.defaultOpen ?? false));
	useEffect(() => {
		if (fold.epoch > 0) setOpen(fold.open);
	}, [fold.epoch, fold.open]);
	const xdev = executeXdevDispatch(props);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const label = intent ? toolIntentLabel(intent) : undefined;
	const name = xdev?.tool ?? props.name;
	const result = xdev
		? { content: props.result!.content, details: xdev.inner, isError: props.result!.isError }
		: props.result;
	const renderer = resolveToolRenderer(name);
	const renderProps: ToolRenderProps = {
		name,
		args: xdev?.args ?? args,
		result,
		running: props.running,
		host: props.host,
	};
	const commands = props.name === "bash" ? toolCommandRecords(props.result) : [];

	const isError = props.result?.isError === true;
	const status = props.running ? "run" : isError ? "err" : props.result ? "ok" : "pending";
	const partial = props.running && !props.result && props.partial ? stripAnsi(replaceTabs(props.partial)) : "";
	const partialShown = useShownAfter(partial !== "", PARTIAL_DELAY_MS);

	return (
		<>
			<div className={`tv-card${isError ? " tv-card--error" : ""}`}>
				<button
					type="button"
					className="tv-head"
					aria-expanded={open}
					onClick={() => setOpen(v => !v)}
					title={label}
				>
					{status === "run" ? (
						<span className="tv-spin" aria-label="running" />
					) : (
						<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
					)}
					<span className="tv-name">{xdev ? `xd://${name}` : name}</span>
					<span className="tv-sum">
						<renderer.Summary {...renderProps} />
					</span>
					<span className="tv-chev" aria-hidden="true" />
				</button>
				{open && (
					<div className="tv-body">
						{label && <div className="tv-intent">{label}</div>}
						{renderer.Body ? <renderer.Body {...renderProps} /> : null}
					</div>
				)}
				{partialShown && (
					<pre className="tv-partial">{partial.length > 2048 ? `…${partial.slice(-2048)}` : partial}</pre>
				)}
			</div>
			{commands.length > 0 && (
				<div className="tv-cells">
					{commands.map((record, index) =>
						record.mode === "execute" ? (
							<ToolView
								// biome-ignore lint/suspicious/noArrayIndexKey: records keep their order; the same tool can run twice.
								key={index}
								name={record.tool}
								args={record.args ?? {}}
								result={{ content: [], details: record.inner, isError: record.exitCode !== 0 }}
								host={props.host}
							/>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: as above.
							<div className="tv-cmd" key={index}>
								<span className="tv-cmd-text">{`${record.tool} --help`}</span>
							</div>
						),
					)}
				</div>
			)}
		</>
	);
}
