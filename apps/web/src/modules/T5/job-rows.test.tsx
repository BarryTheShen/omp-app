import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type BackgroundJobCommand,
  BackgroundJobCommandContext,
} from "@/modules/U3/tool-card/background-job";
import { JobRows } from "./coordination";
import { useJobStops } from "./job-stops";
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

function renderJobs(jobs: readonly JobSnapshot[], gateway: BackgroundJobCommand | undefined) {
  return render(
    <BackgroundJobCommandContext.Provider value={gateway}>
      <JobsWithStops jobs={jobs} />
    </BackgroundJobCommandContext.Provider>,
  );
}

describe("T5 Tasks view: stopping background jobs", () => {
  test("a running job has a named Stop control; a finished job has none", () => {
    renderJobs(
      [job("bg_1", "running"), job("bg_2", "completed")],
      vi.fn(async () => []),
    );
    expect(screen.getByRole("button", { name: "Stop background job bg_1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop background job bg_2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop all background jobs" })).toBeTruthy();
  });

  test("a chat with no command gateway offers no Stop, and nothing to stop all", () => {
    renderJobs([job("bg_1", "running")], undefined);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  test("Stop sends /jobs kill for that job, shows omp's words, and the control goes away", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Stopped background job bg_1."),
    );
    expect(gateway).toHaveBeenCalledWith("/jobs kill bg_1");
    expect(screen.queryByRole("button", { name: "Stop background job bg_1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop background job bg_2" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Could not stop background job bg_1: the command gateway is closed",
      ),
    );
    expect(screen.getByRole("button", { name: "Stop background job bg_1" })).toBeTruthy();
  });

  test("a job omp stopped reads Cancelled in its row, and the job still running reads Running", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled background job bg_1."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Stopped background job bg_1."),
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  test("a job omp had no running job for reads Already finished, never Running", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => [
      'No running background job with id "bg_1".',
    ]);
    renderJobs([job("bg_1", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
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
  });

  test("a Stop all whose count differs from the rows shown keeps their status and says omp's count", async () => {
    const gateway = vi.fn<BackgroundJobCommand>(async () => ["Cancelled 1 background job."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop all background jobs" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Stopped 1 background job."),
    );
    // omp stopped one job, but the card lists two running ones and cannot tell which: no row claims a status.
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  test("a job stopped on its own, then Stop all, reads Cancelled for the rest", async () => {
    const gateway = vi
      .fn<BackgroundJobCommand>()
      .mockResolvedValueOnce(["Cancelled background job bg_1."])
      .mockResolvedValueOnce(["Cancelled 1 background job."]);
    renderJobs([job("bg_1", "running"), job("bg_2", "running")], gateway);
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Stop all background jobs" }));
    await waitFor(() => expect(screen.getByText("Stopped 1 background job.")).toBeTruthy());
    expect(gateway).toHaveBeenLastCalledWith("/jobs kill all");
    expect(screen.getAllByText("Cancelled")).toHaveLength(2);
    expect(screen.queryByText("Running")).toBeNull();
  });
});
