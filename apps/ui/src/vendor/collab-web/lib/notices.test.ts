import { describe, expect, test } from "vitest";
import { deliveredText, describeNotice, jobRows } from "./notices";

describe("background job rows", () => {
	test("one row per job of a batch, in omp's words, with its type, id and how long it ran", () => {
		expect(
			jobRows({
				jobs: [
					{ jobId: "bg_5", type: "bash", status: "completed", durationMs: 233_842 },
					{ jobId: "bg_6", type: "task", status: "failed" },
					{ jobId: "bg_7", status: "cancelled", durationMs: 1_500 },
				],
			}),
		).toEqual([
			{ tone: "ok", text: "Background job completed", type: "bash", jobId: "bg_5", duration: "3m54s" },
			{ tone: "err", text: "Background job failed", type: "task", jobId: "bg_6" },
			{ tone: "muted", text: "Background job cancelled", type: "job", jobId: "bg_7", duration: "1.5s" },
		]);
	});

	test("an older delivery's single job on the details, and details with nothing, still make one row", () => {
		expect(jobRows({ jobId: "bg_1", type: "bash", durationMs: 2_000 })).toEqual([
			{ tone: "ok", text: "Background job completed", type: "bash", jobId: "bg_1", duration: "2.0s" },
		]);
		expect(jobRows(undefined)).toEqual([
			{ tone: "ok", text: "Background job completed", type: "job", jobId: "unknown" },
		]);
	});

	test("the folded text is what the job delivered, without omp's wrapper or its line to the model", () => {
		const content =
			"<system-notice>\nBackground job bg_5 has completed. Resume your work using the result below.\n#### build\nok\n</system-notice>";
		expect(deliveredText(content)).toBe("#### build\nok");
		expect(deliveredText([{ type: "text", text: content }, { type: "image", data: "x" }])).toBe("#### build\nok");
	});
});

describe("omp's other messages (#2827)", () => {
	const envelope =
		"<irc>\nIncoming IRC message from agent `StressA`:\n\nBB probe passed.\n\nIf response expected, reply via `write`.\n</irc>";

	test("an IRC message is who wrote it and what it says, not the envelope omp gives the model", () => {
		const note = describeNotice("irc:incoming", { id: "m1", from: "StressA", message: "BB probe passed." }, envelope);
		expect(note).toEqual({ known: true, heading: "Message from StressA", rows: [], body: "BB probe passed." });
	});

	test("without the message in its details, the envelope's inside stands in, its tag gone", () => {
		const note = describeNotice("irc:incoming", {}, envelope);
		expect(note.heading).toBe("Message from another agent");
		expect(note.body.startsWith("Incoming IRC message from agent `StressA`:")).toBe(true);
		expect(note.body).not.toContain("<irc>");
	});

	test("the other IRC kinds name both ends, from their details", () => {
		expect(describeNotice("irc:autoreply", { to: "Lead", body: "busy" }, "").heading).toBe("Automatic reply to Lead");
		expect(describeNotice("irc:relay", { from: "A", to: "B", body: "hi" }, "").heading).toBe("Message from A to B");
		expect(describeNotice("irc:workpool", { pool: "p1", to: "W2", mode: "steer", body: "go" }, "")).toMatchObject({
			heading: "Pool p1 to W2 (steer)",
			body: "go",
		});
	});

	test("a launch's ended processes are rows as omp writes them; failed by state or a non-zero exit", () => {
		const note = describeNotice(
			"launch-completion",
			{
				daemons: [
					{ name: "dev", state: "exited", exitCode: 0, startedAt: 1_000, exitedAt: 3_500 },
					{ name: "watch", state: "exited", exitCode: 2 },
					{ name: "db", state: "failed" },
				],
			},
			"Launch finished.",
		);
		expect(note.heading).toBeUndefined();
		expect(note.rows).toEqual([
			{ tone: "ok", text: "Supervised process completed", name: "dev", exit: 0, duration: "2.5s" },
			{ tone: "err", text: "Supervised process failed", name: "watch", exit: 2 },
			{ tone: "err", text: "Supervised process failed", name: "db" },
		]);
	});

	test("the advisor's notes, and a tangent's work cut as omp cuts it", () => {
		expect(describeNotice("advisor", { notes: [{ note: "Check the tests." }, { note: "Rename it." }] }, "")).toMatchObject({
			heading: "Advisor note",
			body: "Check the tests.\n\nRename it.",
		});
		const work = `Look into ${"x".repeat(80)}`;
		const heading = describeNotice("background-tan-dispatch", { jobId: "bg_3", work }, "").heading ?? "";
		expect(heading).toBe(`Tangent sent to background job bg_3: ${work.slice(0, 55)}…`);
	});

	test("a kind it does not know keeps its type as a chip and its text without omp's tag", () => {
		expect(describeNotice("something-new", undefined, "<system-notice>\nHello.\n</system-notice>")).toEqual({
			known: false,
			rows: [],
			body: "Hello.",
		});
	});
});
