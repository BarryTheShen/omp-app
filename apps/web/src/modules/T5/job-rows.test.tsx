import type { BackgroundJobStop } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type BackgroundJobCommand,
  BackgroundJobCommandContext,
} from "@/modules/U3/tool-card/background-job";
import { boxAt } from "@/modules/U3/tool-card/test-support";
import { keptStopOutcome, resolveStopOutcome } from "../U3/tool-card/stopped-jobs";
import { formatDuration, JobRows } from "./coordination";
import {
  type BackgroundJobKeptStops,
  BackgroundJobKeptStopsContext,
  useJobStops,
} from "./job-stops";
import type { JobSnapshot } from "./models";

afterEach(() => cleanup());

function job(id: string, status: JobSnapshot["status"]): JobSnapshot {
  return { id, type: "bash", status, label: `sleep 120; echo ${id}`, durationMs: 1000 };
}

/** A card's job list with its stop controls, as the Tasks cards hold them. */
function JobsWithStops({ jobs }: { readonly jobs: readonly JobSnapshot[] }) {
  const stops = useJobStops();
  return <JobRows jobs={jobs} stops={stops} />;
}

function jobsTree(
  jobs: readonly JobSnapshot[],
  gateway: BackgroundJobCommand | undefined,
  keptStops?: BackgroundJobKeptStops,
) {
  return (
    <BackgroundJobCommandContext.Provider value={gateway}>
      <BackgroundJobKeptStopsContext.Provider value={keptStops}>
        <JobsWithStops jobs={jobs} />
      </BackgroundJobKeptStopsContext.Provider>
    </BackgroundJobCommandContext.Provider>
  );
}

function renderJobs(
  jobs: readonly JobSnapshot[],
  gateway: BackgroundJobCommand | undefined,
  keptStops?: BackgroundJobKeptStops,
) {
  return render(jobsTree(jobs, gateway, keptStops));
}

describe("T5 duration labels", () => {
  test("durations under one second are shown in milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });
});

describe("T5 Tasks view: stopping background jobs", () => {
  test("a kept stop does not override failed or completed row snapshots", () => {
    const keptStops: BackgroundJobKeptStops = {
      stops: new Map<string, BackgroundJobStop>([
        ["bg_failed", { jobId: "bg_failed", status: "stopped", at: 10 }],
        ["bg_completed", { jobId: "bg_completed", status: "stopped", at: 10 }],
      ]),
      launchedAt: new Map([
        ["bg_failed", 5],
        ["bg_completed", 5],
      ]),
    };
    renderJobs(
      [job("bg_failed", "failed"), job("bg_completed", "completed")],
      vi.fn(async () => []),
      keptStops,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.queryByText("Cancelled")).toBeNull();
  });

  test("a kept stop after launch gives Tasks the same outcome as the card resolver", () => {
    const stop = { jobId: "bg_1", status: "stopped", at: 20 } as const;
    const launchedAt = 10;
    const cardOutcome = resolveStopOutcome(undefined, true, () =>
      keptStopOutcome(stop, launchedAt),
    );
    expect(cardOutcome).toEqual({
      status: "stopped",
      sentence: "The background command stopped before its result came back.",
    });
    renderJobs(
      [job("bg_1", "running")],
      vi.fn(async () => []),
      { stops: new Map([["bg_1", stop]]), launchedAt: new Map([["bg_1", launchedAt]]) },
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(
      screen.getByText("The background command stopped before its result came back."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop background job 1" })).toBeNull();
  });

  test("a stop recorded before a reused job id launch is ignored", () => {
    const stop = { jobId: "bg_1", status: "stopped", at: 10 } as const;
    renderJobs(
      [job("bg_1", "running")],
      vi.fn(async () => []),
      { stops: new Map([["bg_1", stop]]), launchedAt: new Map([["bg_1", 20]]) },
    );
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop background job 1" })).toBeTruthy();
  });

  test("a kept stop with no known launch time is ignored", () => {
    const stop = { jobId: "bg_1", status: "stopped", at: 10 } as const;
    renderJobs(
      [job("bg_1", "running")],
      vi.fn(async () => []),
      { stops: new Map([["bg_1", stop]]), launchedAt: new Map() },
    );
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop background job 1" })).toBeTruthy();
  });
  test("a running job has a named Stop control; a finished job has none", () => {
    renderJobs(
      [job("bg_1", "running"), job("bg_2", "completed")],
      vi.fn(async () => []),
    );
    expect(screen.getByRole("button", { name: "Stop background job 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop background job 2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop all background jobs" })).toBeTruthy();
  });

  test("unnamed rows use plain position labels for people and controls", () => {
    const { container } = renderJobs(
      [
        { ...job("internal-id-1", "running"), label: "" },
        { ...job("internal-id-2", "running"), label: "" },
      ],
      vi.fn(async () => []),
    );
    expect(container.textContent).not.toContain("internal-id-1");
    expect(container.textContent).not.toContain("internal-id-2");
    expect(screen.getByText("Background job 1")).toBeTruthy();
    expect(screen.getByText("Background job 2")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Stop background job 1" }).getAttribute("aria-label"),
    ).not.toContain("internal-id-1");
    expect(
      screen.getByRole("button", { name: "Stop background job 2" }).getAttribute("aria-label"),
    ).not.toContain("internal-id-2");
  });

  test("a chat with no command gateway offers no Stop, and nothing to stop all", () => {
    renderJobs([job("bg_1", "running")], undefined);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  test("Stop sends /jobs kill for that job, shows omp's words, and the control goes away", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job 1" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "The background command stopped before its result came back.",
      ),
    );
    expect(gateway).toHaveBeenCalledWith("/jobs kill bg_1");
    expect(screen.queryByRole("button", { name: "Stop background job 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop background job 2" })).toBeTruthy();
  });

  test("a Stop press still stops its job when the row moves under a still pointer", () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    const first = job("bg_1", "running");
    const second = job("bg_2", "running");
    const view = renderJobs([first, second], gateway);
    const stop = screen.getByRole("button", { name: "Stop background job 1" });
    const box = vi.spyOn(stop, "getBoundingClientRect").mockReturnValue(boxAt(314, 502));
    fireEvent.pointerDown(stop);
    // The card updates between the press and the release: the row moves down 28 px, and the pointer stays where it was.
    box.mockReturnValue(boxAt(314, 530));
    view.rerender(jobsTree([{ ...first, durationMs: 4000 }, second], gateway));
    // The release is at the press point, which is still inside the box the control had when the press began.
    const row = stop.closest("li");
    if (row === null) throw new Error("no job row");
    fireEvent.click(row, { clientX: 339, clientY: 517, detail: 1 });
    expect(gateway).toHaveBeenCalledWith("/jobs kill bg_1");
  });

  test("a Stop press the pointer slides off before releasing, within the row, stops nothing", () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running")], gateway);
    const stop = screen.getByRole("button", { name: "Stop background job 1" });
    vi.spyOn(stop, "getBoundingClientRect").mockReturnValue(boxAt(314, 502));
    fireEvent.pointerDown(stop);
    const row = stop.closest("li");
    if (row === null) throw new Error("no job row");
    // The pointer slid up onto the job's label, well outside the box the press began on, so the click goes to the row.
    fireEvent.click(row, { clientX: 339, clientY: 470, detail: 1 });
    expect(gateway).not.toHaveBeenCalled();
  });

  test("a mouse press and release on Stop stops its job once", () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running")], gateway);
    const stop = screen.getByRole("button", { name: "Stop background job 1" });
    vi.spyOn(stop, "getBoundingClientRect").mockReturnValue(boxAt(314, 502));
    fireEvent.pointerDown(stop);
    fireEvent.click(stop, { clientX: 339, clientY: 517, detail: 1 });
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  test("a Stop press released on another job's row stops nothing", () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    const stop = screen.getByRole("button", { name: "Stop background job 1" });
    vi.spyOn(stop, "getBoundingClientRect").mockReturnValue(boxAt(314, 502));
    fireEvent.pointerDown(stop);
    // The release lands on the other row, so the browser sends the click to the list that holds both rows.
    const list = stop.closest("ul");
    if (list === null) throw new Error("no job list");
    fireEvent.click(list, { clientX: 339, clientY: 600, detail: 1 });
    expect(gateway).not.toHaveBeenCalled();
  });

  test("a press that starts on a job's label and ends on its Stop control stops nothing", () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running")], gateway);
    const stop = screen.getByRole("button", { name: "Stop background job 1" });
    const row = stop.closest("li");
    if (row === null) throw new Error("no job row");
    fireEvent.pointerDown(screen.getByText("sleep 120; echo bg_1"));
    // The release lands on the Stop control inside the row, so the browser sends the click to the row.
    fireEvent.click(row, { clientX: 339, clientY: 517, detail: 1 });
    expect(gateway).not.toHaveBeenCalled();
  });

  test("a Stop all press still stops every running job when the header moves under a still pointer", () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled 2 background jobs."]);
    const first = job("bg_1", "running");
    const second = job("bg_2", "running");
    const view = renderJobs([first, second], gateway);
    const stopAll = screen.getByRole("button", { name: "Stop all background jobs" });
    const box = vi.spyOn(stopAll, "getBoundingClientRect").mockReturnValue(boxAt(600, 300));
    fireEvent.pointerDown(stopAll);
    box.mockReturnValue(boxAt(600, 330));
    view.rerender(jobsTree([first, second], gateway));
    // The release is at the press point, inside the box Stop all had when the press began; the click goes to the header.
    const header = stopAll.parentElement;
    if (header === null) throw new Error("no job header");
    fireEvent.click(header, { clientX: 625, clientY: 314, detail: 1 });
    expect(gateway).toHaveBeenCalledWith("/jobs kill all");
  });

  test("Stop all sends /jobs kill all and says how many omp stopped", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled 2 background jobs."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop all background jobs" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Stopped 2 background jobs."),
    );
    expect(gateway).toHaveBeenCalledWith("/jobs kill all");
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  test("a stop that does not reach omp keeps the control and says why", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => {
      throw new Error("the command gateway is closed");
    });
    renderJobs([job("bg_1", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job 1" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Could not stop background job bg_1: the command gateway is closed",
      ),
    );
    expect(screen.getByRole("button", { name: "Stop background job 1" })).toBeTruthy();
  });

  test("a job omp stopped reads Cancelled in its row, and the job still running reads Running", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job 1" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "The background command stopped before its result came back.",
      ),
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  test("a job omp had no running job for reads Already finished, never Running", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => [
      'No running background job with id "bg_1".',
    ]);
    renderJobs([job("bg_1", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job 1" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Already finished: omp has no running job with id bg_1.",
      ),
    );
    expect(screen.getByText("Already finished")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
  });

  test("Stop all reads every running row as Cancelled", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled 2 background jobs."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop all background jobs" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Stopped 2 background jobs."),
    );
    expect(screen.getAllByText("Cancelled")).toHaveLength(2);
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText(/may be out of date/)).toBeNull();
  });

  test("Stop all with no running job left reads the running rows as Already finished", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => [
      "No running background jobs to cancel.",
    ]);
    renderJobs([job("bg_1", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop all background jobs" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Already finished: omp has no running background jobs to stop.",
      ),
    );
    expect(screen.getByText("Already finished")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  test("a Stop all whose count differs from the rows shown keeps their Stop controls, and says their statuses may be out of date", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled 1 background job."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop all background jobs" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Stopped 1 background job."),
    );
    // omp stopped one job, but the card lists two running ones and cannot tell which: no row claims a status, and
    // each keeps its Stop control so it can still be stopped.
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop background job 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop background job 2" })).toBeTruthy();
    expect(
      screen.getByText(
        "omp did not say which of these jobs it stopped, so their statuses may be out of date.",
      ),
    ).toBeTruthy();
  });

  test("a job stopped on its own, then Stop all, reads Cancelled for the rest", async () => {
    const gateway = vi
      .fn<BackgroundJobCommand>()
      .mockResolvedValueOnce(["Cancelled background job bg_1."])
      .mockResolvedValueOnce(["Cancelled 1 background job."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job 1" }));
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Stop all background jobs" }));
    await waitFor(() => expect(screen.getByText("Stopped 1 background job.")).toBeTruthy());
    expect(gateway).toHaveBeenLastCalledWith("/jobs kill all");
    expect(screen.getAllByText("Cancelled")).toHaveLength(2);
    expect(screen.queryByText("Running")).toBeNull();
  });

  test("a stopped task's row shows the output its worker produced, not omp's result block or its words for the model", () => {
    const stopped: JobSnapshot = {
      id: "SteerProbe",
      type: "task",
      status: "cancelled",
      label: "SteerProbe",
      durationMs: 939,
      resultText:
        '<task-result id="SteerProbe" agent="task" status="cancelled" duration="938ms">\n<meta lines="1" size="0B" />\n<abort-reason>The operation was aborted.</abort-reason>\n<output>\n(no output) after 2 req\n</output>\n</task-result>\n\nSteerProbe was aborted — transcript at history://SteerProbe',
    };
    const { container } = renderJobs([stopped], undefined);
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("(no output) after 2 req")).toBeTruthy();
    expect(container.textContent).not.toContain("<task-result");
    expect(container.textContent).not.toContain("history://");
  });
});
