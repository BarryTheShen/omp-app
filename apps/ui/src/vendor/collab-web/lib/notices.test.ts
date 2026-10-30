import { describe, expect, test } from "vitest";
import { deliveredText, jobRows } from "./notices";

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
