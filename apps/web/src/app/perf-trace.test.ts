import type { ClientTraceReport } from "@omp-app/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { installPerfTrace, perfMark, perfTraceStart } from "./perf-trace";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("opt-in performance trace", () => {
  test("disabled tracing does not report", () => {
    const report = vi.fn<(trace: ClientTraceReport) => void>();
    const stop = installPerfTrace(false, report);
    stop();
    expect(report).not.toHaveBeenCalled();
  });

  test("enabled tracing reports explicit lifecycle marks and numeric gaps", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-app-root="true"><button>Open</button></div>';
    const reports: ClientTraceReport[] = [];
    const stop = installPerfTrace(true, (trace) => reports.push(trace));
    perfTraceStart();
    perfMark("first_feedback");
    perfMark("rpc_open_returned");
    perfMark("window_applied");
    perfMark("newest_20_painted");
    perfMark("composer_typable");
    perfMark("send_accepted");
    perfMark("send_delivered");
    vi.advanceTimersByTime(15_100);
    stop();
    expect(reports).toHaveLength(1);
    expect(typeof reports[0]?.marks.click).toBe("number");
    expect(typeof reports[0]?.marks.data_app_root_visible).toBe("number");
    expect(typeof reports[0]?.marks.first_feedback).toBe("number");
    expect(typeof reports[0]?.marks.window_applied).toBe("number");
    expect(typeof reports[0]?.marks.rpc_open_returned).toBe("number");
    expect(typeof reports[0]?.marks.newest_20_painted).toBe("number");
    expect(typeof reports[0]?.marks.send_accepted).toBe("number");
    expect(typeof reports[0]?.marks.send_delivered).toBe("number");
    expect(reports[0]?.gaps.every((gap) => typeof gap === "number")).toBe(true);
  });
});
