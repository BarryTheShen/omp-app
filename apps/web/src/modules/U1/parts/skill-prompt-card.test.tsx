import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CustomNote } from "./custom-note";
import { describeSkillPrompt } from "./skill-prompt-card";

afterEach(() => cleanup());

/*
 * A real omp 18.8.9 skill run, as its session file records it (omp 18.12.6 builds the same `details`, extensibility/skills.ts:705-712): `details` is { name, path, args, prompt, lineCount };
 * `content` is the generated prompt, shaped like `generated` below.
 */
const SOURCE = "/home/me/.omp/agent/skills/review-notes/SKILL.md";
const details = {
  name: "review-notes",
  path: SOURCE,
  args: "fix the typo in the intro",
  prompt: "/skill:review-notes fix the typo in the intro",
  lineCount: 2,
};
const generated = [
  '[IMPORTANT: User invoked the "review-notes" skill; follow its instructions. Full skill below.]',
  "Check every note for typos before you answer.",
  "---",
  "[Skill directory: /home/me/.omp/agent/skills/review-notes]",
  "User: fix the typo in the intro",
].join("\n\n");

describe("describeSkillPrompt", () => {
  test("reads the name, arguments, source and prompt from omp's details and text", () => {
    expect(describeSkillPrompt(details, generated)).toEqual({
      name: "review-notes",
      args: "fix the typo in the intro",
      source: SOURCE,
      prompt: generated,
    });
  });

  test("a field omp did not record, or a blank or wrongly typed one, reads as missing", () => {
    expect(describeSkillPrompt({ name: "  ", args: "", path: 3 }, "Body.")).toEqual({
      name: undefined,
      args: undefined,
      source: undefined,
      prompt: "Body.",
    });
    expect(describeSkillPrompt(undefined, "Body.").name).toBeUndefined();
  });
});

describe("the skill card in the chat", () => {
  test("a skill run is one card, collapsed: its name, arguments and source show; its prompt does not", () => {
    const { container } = render(
      <CustomNote source={{ customType: "skill-prompt", details, text: generated }} />,
    );
    expect(container.querySelectorAll('[data-slot="u1-skill-card"]')).toHaveLength(1);
    expect(container.querySelector('[data-custom-type="skill-prompt"]')).not.toBeNull();
    expect(screen.getByText("review-notes")).toBeTruthy();
    expect(screen.getByText("fix the typo in the intro")).toBeTruthy();
    expect(screen.getByText(SOURCE)).toBeTruthy();
    const trigger = screen.getByRole("button", { name: /Show prompt/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Check every note for typos/)).toBeNull();
  });

  test("the control opens the full prompt and closes it again", () => {
    render(<CustomNote source={{ customType: "skill-prompt", details, text: generated }} />);
    fireEvent.click(screen.getByRole("button", { name: /Show prompt/ }));
    expect(screen.getByText(/Check every note for typos/)).toBeTruthy();
    const open = screen.getByRole("button", { name: /Hide prompt/ });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(open);
    expect(screen.queryByText(/Check every note for typos/)).toBeNull();
    expect(screen.getByRole("button", { name: /Show prompt/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  test("a skill run whose details omp did not record still shows the card and its prompt", () => {
    render(
      <CustomNote source={{ customType: "skill-prompt", details: undefined, text: generated }} />,
    );
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show prompt/ }));
    expect(screen.getByText(/Check every note for typos/)).toBeTruthy();
  });
});
