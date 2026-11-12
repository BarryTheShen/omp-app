import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { FoldContext, NO_FOLDS } from "../../lib/fold";
import { EntryRow } from "./Transcript";

/** An agent's message to this chat, as omp's file holds it (`irc:incoming`, shown). */
function agentMessage(message: string): SessionEntry {
	return {
		type: "custom_message",
		id: "entry-1",
		parentId: null,
		timestamp: "2026-11-12T16:00:00.000Z",
		customType: "irc:incoming",
		display: true,
		details: { id: "m1", from: "CensusProbe", message },
		content: `Incoming IRC message from agent \`CensusProbe\`:\n${message}`,
	} as unknown as SessionEntry;
}

const LONG = [
	"**WEBKIT FOLLOW-UP** on the desktop and the phone.",
	"",
	"1. theme_pick 256 ms",
	"2. chat_list_switch 144 ms",
	"3. Ctrl+Tab 136 ms, the same with and without hidden tabs.",
].join("\n");

const draw = (entry: SessionEntry, tools = NO_FOLDS.tools): string =>
	renderToStaticMarkup(
		<FoldContext.Provider value={{ ...NO_FOLDS, tools }}>
			<EntryRow entry={entry} results={new Map()} active={new Map()} />
		</FoldContext.Provider>,
	);

describe("an agent's message in the transcript", () => {
	test("a long one starts folded: who wrote it and the start of its first line, the rest behind its button", () => {
		const html = draw(agentMessage(LONG));
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("Message from CensusProbe");
		expect(html).toContain("WEBKIT FOLLOW-UP on the desktop and the phone.");
		expect(html).not.toContain("chat_list_switch");
	});

	test("a short one shows whole, with nothing to open", () => {
		const html = draw(agentMessage("BB probe passed."));
		expect(html).toContain("Message from CensusProbe");
		expect(html).toContain("BB probe passed.");
		expect(html).not.toContain("aria-expanded");
	});

	test("the pane's fold of tool output opens a long one whole, and folds it again", () => {
		const opened = draw(agentMessage(LONG), { open: true, epoch: 1 });
		expect(opened).toContain('aria-expanded="true"');
		expect(opened).toContain("chat_list_switch");
		const folded = draw(agentMessage(LONG), { open: false, epoch: 2 });
		expect(folded).not.toContain("chat_list_switch");
	});
});
