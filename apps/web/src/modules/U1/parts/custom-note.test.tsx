import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { U1_REAL_ENTRIES } from "../fixtures/real-entries";
import {
  CustomNote,
  type CustomNoteSource,
  describeCustomMessage,
  WorkerNoteContext,
  type WorkerNoteLookup,
  withoutWrapper,
} from "./custom-note";

afterEach(() => cleanup());

function sourceOf(name: string) {
  const sample = U1_REAL_ENTRIES.find((candidate) => candidate.name.startsWith(name));
  if (sample === undefined) throw new Error(`no fixture named ${name}`);
  const { customType, content, details } = sample.entry;
  if (typeof customType !== "string" || typeof content !== "string") throw new Error("bad fixture");
  return { customType, details, text: content };
}

describe("withoutWrapper", () => {
  test("shows what is inside the tag omp wraps its text for the model in", () => {
    expect(withoutWrapper("<system-notice>\nJob done.\n</system-notice>")).toBe("Job done.");
    expect(withoutWrapper('<advisory severity="blocker">\nFix it.\n</advisory>')).toBe("Fix it.");
  });

  test("leaves text that has no such wrapper, or two of them, as it is", () => {
    expect(withoutWrapper("Plain sentence.")).toBe("Plain sentence.");
    expect(withoutWrapper("<a>one</a> and <b>two</b>")).toBe("<a>one</a> and <b>two</b>");
  });
});

describe("describeCustomMessage", () => {
  test("a message from another agent names the agent and shows the message, from the details", () => {
    const view = describeCustomMessage(sourceOf("custom_message irc:incoming"));
    expect(view.heading).toBe("Message from Reviewer");
    expect(view.body).toContain("I need one measurement I cannot take");
    expect(view.body).not.toContain("Incoming IRC message");
  });

  test("an advisor note joins the notes in the details", () => {
    const view = describeCustomMessage({
      customType: "advisor",
      details: { notes: [{ note: "First." }, { note: "Second." }] },
      text: "<advisory>ignored</advisory>",
    });
    expect(view).toEqual({ heading: "Advisor note", body: "First.\n\nSecond." });
  });

  test("a bash job shows its typed line and keeps omp's full message in details", () => {
    const view = describeCustomMessage(sourceOf("custom_message async-result: a command"));
    expect(view.heading).toBe("sleep 120 finished · 120 seconds.");
    expect(view.body).toContain("Background job bg_3 has completed.");
    expect(view.body).toContain("(no output)");
    expect(view.bodyInDetails).toBe(true);
  });

  test("a finished process keeps its note", () => {
    expect(describeCustomMessage(sourceOf("custom_message launch-completion")).heading).toBe(
      "Process finished",
    );
  });

  test("summarizes multiple background jobs from labels, ids and durations", () => {
    const view = describeCustomMessage({
      customType: "async-result",
      details: {
        jobs: [
          { type: "bash", label: "echo start\n&& echo done", durationMs: 1_000 },
          { type: "bash", jobId: "bg_2", durationMs: 2_000 },
        ],
      },
      text: "<system-notice>Model-facing text.</system-notice>",
    });
    expect(view.heading).toBe(
      "echo start && echo done finished · 1 second. · Background command bg_2 finished · 2 seconds.",
    );
    expect(view.body).toBe("Model-facing text.");
    expect(view.bodyInDetails).toBe(true);
  });

  test("a kind with no heading shows its text alone, and a message without the details it expects still shows", () => {
    expect(
      describeCustomMessage({ customType: "extension-note", details: undefined, text: "Hi." }),
    ).toEqual({ heading: undefined, body: "Hi." });
    const view = describeCustomMessage({
      customType: "irc:incoming",
      details: {},
      text: "<irc>\nHello.\n</irc>",
    });
    expect(view).toEqual({ heading: "Message from another agent", body: "Hello." });
  });

  test("a tangent is one line that names its job and work, with omp's full text kept back", () => {
    const view = describeCustomMessage(sourceOf("custom_message background-tan-dispatch"));
    expect(view.heading).toBe("Tangent sent to background job bg_1: Check the login flow");
    expect(view.bodyInDetails).toBe(true);
    expect(view.body).toContain("Tangential user task");
    expect(view.body).not.toContain("<system-notice");
  });

  test("a tangent's work is one line of at most 56 characters, cut with an ellipsis as omp cuts it", () => {
    const heading = (work: string) =>
      describeCustomMessage({
        customType: "background-tan-dispatch",
        details: { jobId: "bg_2", work },
        text: "<system-notice>Done.</system-notice>",
      }).heading;
    expect(heading("Find where\tthe\nsession   list is sorted")).toBe(
      "Tangent sent to background job bg_2: Find where the session list is sorted",
    );
    expect(heading("a".repeat(56))).toBe(`Tangent sent to background job bg_2: ${"a".repeat(56)}`);
    expect(heading("a".repeat(57))).toBe(`Tangent sent to background job bg_2: ${"a".repeat(55)}…`);
  });

  test("a tangent with no work names only its job, and one with no details names a background job", () => {
    expect(
      describeCustomMessage({
        customType: "background-tan-dispatch",
        details: { jobId: "bg_3", work: "   " },
        text: "<system-notice>Done.</system-notice>",
      }).heading,
    ).toBe("Tangent sent to background job bg_3");
    expect(
      describeCustomMessage({
        customType: "background-tan-dispatch",
        details: undefined,
        text: "<system-notice>Done.</system-notice>",
      }),
    ).toEqual({ heading: "Tangent sent to a background job", body: "Done.", bodyInDetails: true });
  });
});

describe("CustomNote", () => {
  test("a finished bash notice shows its typed line and keeps omp's message behind Full message", () => {
    const { container } = render(
      <CustomNote source={sourceOf("custom_message async-result: a command")} />,
    );
    expect(screen.getByText("sleep 120 finished · 120 seconds.")).toBeTruthy();
    const details = container.querySelector<HTMLDetailsElement>(
      '[data-slot="u1-custom-note-details"]',
    );
    expect(details?.open).toBe(false);
    expect(screen.getByText("Full message")).toBeTruthy();
    fireEvent.click(screen.getByText("Full message"));
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain("(no output)");
    expect(details?.textContent).toContain("Wall time: 120.08 seconds");
    expect(details?.textContent).toContain("Resume your work using the result below");
  });

  test("a tangent shows its line, and omp's full text stays in a closed details control", () => {
    const { container } = render(
      <CustomNote source={sourceOf("custom_message background-tan-dispatch")} />,
    );
    expect(
      screen.getByText("Tangent sent to background job bg_1: Check the login flow"),
    ).toBeTruthy();
    const details = container.querySelector<HTMLDetailsElement>(
      '[data-slot="u1-custom-note-details"]',
    );
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Tangential user task");
    expect(screen.getByText("Full message")).toBeTruthy();
  });

  test("the other notes have no details control, so their text is shown", () => {
    const { container } = render(<CustomNote source={sourceOf("custom_message advisor")} />);
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByText(/Dedup did not work/)).toBeTruthy();
  });

  test("the other kinds of omp's messages keep their note and never get a skill card", () => {
    const { container } = render(<CustomNote source={sourceOf("custom_message irc:incoming")} />);
    expect(screen.getByText("Message from Reviewer")).toBeTruthy();
    expect(container.querySelector('[data-slot="u1-custom-note-body"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="u1-skill-card"]')).toBeNull();
  });
});

describe("a background worker's notice", () => {
  // omp's text for a worker that failed: it tells the model what to do next, and it carries a raw log path.
  const failedWorker = {
    customType: "async-result",
    details: { jobs: [{ jobId: "FailProbe", type: "task", label: "FailProbe", durationMs: 1200 }] },
    text:
      "<system-notice>\nBackground job FailProbe has completed. Resume your work using the result below.\n" +
      "400 fake provider failure for the failing subagent (type=invalid_request_error) raw-http-request=/home/someone/.omp/logs/http-400-requests/x.json\n" +
      "FailProbe is now idle — message it via `write agent://FailProbe` to follow up; transcript at `history://FailProbe`.\n</system-notice>",
  };
  const ompText = [
    "Resume your work",
    "write agent://",
    "history://",
    "raw-http-request",
    "400 fake provider",
  ];

  function renderNote(
    lookup: WorkerNoteLookup | undefined,
    source: CustomNoteSource = failedWorker,
  ) {
    return render(
      <WorkerNoteContext.Provider value={lookup}>
        <CustomNote source={source} />
      </WorkerNoteContext.Provider>,
    );
  }

  test("names the worker and how it ended, and its transcript is one click away", () => {
    const { container } = renderNote(() => ({
      status: "failed",
      transcript: <p>Its own transcript.</p>,
    }));
    expect(screen.getByText("FailProbe failed.")).toBeTruthy();
    expect(screen.queryByText("Its own transcript.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(screen.getByText("Its own transcript.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Hide transcript" }).getAttribute("aria-expanded"),
    ).toBe("true");
    for (const text of ompText) expect(container.textContent).not.toContain(text);
  });

  test("shows none of omp's text for the model, with the transcript closed or open", () => {
    const { container } = renderNote(() => ({ status: "failed", transcript: null }));
    for (const text of ompText) expect(container.textContent).not.toContain(text);
  });

  test("a failed worker's line says why it failed, in the reason the roster gives", () => {
    renderNote(() => ({
      status: "failed",
      reason: "400 fake provider failure for the failing subagent (type=invalid_request_error)",
      transcript: null,
    }));
    expect(
      screen.getByText(
        "FailProbe failed: 400 fake provider failure for the failing subagent (type=invalid_request_error)",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "View transcript" })).toBeTruthy();
  });

  test.each([
    ["completed", "FailProbe finished."],
    ["failed", "FailProbe failed."],
    ["aborted", "FailProbe was aborted."],
    ["stopped", "FailProbe was stopped."],
    ["running", "FailProbe has ended."],
  ] as const)("a worker whose roster status is %s reads: %s", (status, line) => {
    renderNote(() => ({ status, transcript: null }));
    expect(screen.getByText(line)).toBeTruthy();
  });

  test("a worker the chat does not know has ended, and no transcript is offered", () => {
    const { container } = renderNote(() => undefined);
    expect(screen.getByText("FailProbe has ended.")).toBeTruthy();
    expect(screen.getByText("Its transcript is not available here.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    for (const text of ompText) expect(container.textContent).not.toContain(text);
  });

  test("a notice with a command and worker summarizes its typed job fields", () => {
    const { container } = renderNote(() => ({ status: "completed", transcript: null }), {
      customType: "async-result",
      details: {
        jobs: [
          { jobId: "bg_1", type: "bash" },
          { jobId: "FailProbe", type: "task" },
        ],
      },
      text: "<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n</system-notice>",
    });
    expect(
      screen.getByText("Background command bg_1 finished. · Background task FailProbe finished."),
    ).toBeTruthy();
    const details = container.querySelector<HTMLDetailsElement>(
      '[data-slot="u1-custom-note-details"]',
    );
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Full message"));
    expect(details?.textContent).toContain("Resume your work using the result below");
    expect(container.querySelector('[data-slot="u1-custom-note-worker"]')).toBeNull();
  });

  test("looks the worker up by the agent id omp sends, and the line keeps the job id", () => {
    const lookup = vi.fn((_workerId: string) => ({
      status: "completed" as const,
      transcript: null,
    }));
    renderNote(lookup, {
      customType: "async-result",
      details: { jobs: [{ jobId: "Reviewer-2", type: "task", agentId: "Reviewer" }] },
      text: "<system-notice>\nBackground job Reviewer-2 has completed.\n</system-notice>",
    });
    expect(lookup).toHaveBeenCalledWith("Reviewer");
    expect(lookup).not.toHaveBeenCalledWith("Reviewer-2");
    expect(screen.getByText("Reviewer-2 finished.")).toBeTruthy();
  });

  test("without an agent id, the job id is the worker's id, as before", () => {
    const lookup = vi.fn((_workerId: string) => ({ status: "failed" as const, transcript: null }));
    renderNote(lookup);
    expect(lookup).toHaveBeenCalledWith("FailProbe");
  });
});

describe("the real entries show the words their samples list", () => {
  // The spec `custom-messages-real-entries.spec.ts` checks the same words in the real app on real omp. This is that
  // check without omp: each shown sample's note, with no worker lookup (the chat does not know the workers), shows
  // what its `shows` list says.
  test.each(
    U1_REAL_ENTRIES.filter((sample) => !sample.hidden).map(
      (sample) => [sample.name, sample] as const,
    ),
  )("%s", (_name, sample) => {
    const { container } = render(<CustomNote source={sourceOf(sample.name)} />);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    for (const wanted of sample.shows) expect(text).toContain(wanted.replace(/\s+/g, " "));
  });
});
