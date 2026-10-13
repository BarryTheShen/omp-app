import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { U1_REAL_ENTRIES } from "../fixtures/real-entries";
import { CustomNote, describeCustomMessage, withoutWrapper } from "./custom-note";

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

  test("a finished job and a finished process show their text without the model's wrapper", () => {
    expect(
      describeCustomMessage(sourceOf("custom_message async-result: a command")).body,
    ).toContain("Wall time: 120.08 seconds");
    expect(describeCustomMessage(sourceOf("custom_message launch-completion")).heading).toBe(
      "Process finished",
    );
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
  test("shows the heading and the text of one of omp's messages", () => {
    render(<CustomNote source={sourceOf("custom_message advisor")} />);
    expect(screen.getByText("Advisor note")).toBeTruthy();
    expect(screen.getByText(/Dedup did not work/)).toBeTruthy();
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
