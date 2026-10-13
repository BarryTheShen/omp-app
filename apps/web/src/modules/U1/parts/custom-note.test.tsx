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
});

describe("CustomNote", () => {
  test("shows the heading and the text of one of omp's messages", () => {
    render(<CustomNote source={sourceOf("custom_message advisor")} />);
    expect(screen.getByText("Advisor note")).toBeTruthy();
    expect(screen.getByText(/Dedup did not work/)).toBeTruthy();
  });

  test("the other kinds of omp's messages keep their note and never get a skill card", () => {
    const { container } = render(<CustomNote source={sourceOf("custom_message irc:incoming")} />);
    expect(screen.getByText("Message from Reviewer")).toBeTruthy();
    expect(container.querySelector('[data-slot="u1-custom-note-body"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="u1-skill-card"]')).toBeNull();
  });
});
