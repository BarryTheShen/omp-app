import { describe, expect, test } from "vitest";
import {
  buildGoalObjective,
  EMPTY_GUIDED_ANSWERS,
  GUIDED_QUESTIONS,
  type GuidedAnswers,
  interviewDraftText,
  parseTokenBudget,
} from "./interview";

const answers: GuidedAnswers = {
  objective: "  Ship the parser  ",
  success: "All tests pass",
  verification: "bun run test",
  attempts: " 5 attempts ",
  boundaries: "Only touch src/parser",
  stop: "Stop on a failing migration",
  budget: "5000",
};

describe("GUIDED_QUESTIONS", () => {
  test("asks the six required questions in omp's order, with the token budget asked after them", () => {
    expect(GUIDED_QUESTIONS.map((question) => question.id)).toEqual([
      "objective",
      "success",
      "verification",
      "attempts",
      "boundaries",
      "stop",
    ]);
    expect(GUIDED_QUESTIONS.map((question) => question.question)).toEqual([
      "What should omp get done?",
      "How will you know it is done?",
      "What should omp run to check its own work?",
      "How many attempts may omp make before it stops?",
      "What may omp change, and what must it leave alone?",
      "When should omp stop and ask you?",
    ]);
  });
});

describe("parseTokenBudget", () => {
  test("a blank budget means no limit", () => {
    expect(parseTokenBudget("")).toEqual({ ok: true, tokenBudget: undefined });
    expect(parseTokenBudget("   ")).toEqual({ ok: true, tokenBudget: undefined });
  });

  test("a whole number above zero is the budget, surrounding spaces ignored", () => {
    expect(parseTokenBudget("5000")).toEqual({ ok: true, tokenBudget: 5000 });
    expect(parseTokenBudget(" 42 ")).toEqual({ ok: true, tokenBudget: 42 });
  });

  test("zero is refused with the reason", () => {
    expect(parseTokenBudget("0")).toEqual({
      ok: false,
      message: "Enter a token budget above zero, or leave this blank.",
    });
  });

  test("anything that is not a whole number is refused with the reason", () => {
    expect(parseTokenBudget("12k")).toEqual({
      ok: false,
      message: "Enter a whole number of tokens, or leave this blank.",
    });
    expect(parseTokenBudget("1.5")).toEqual({
      ok: false,
      message: "Enter a whole number of tokens, or leave this blank.",
    });
  });
});

describe("buildGoalObjective", () => {
  test("uses omp's five headings, in order, and puts the attempt cap first under Stop conditions", () => {
    expect(buildGoalObjective(answers)).toBe(
      [
        "## Objective",
        "Ship the parser",
        "",
        "## Success criteria",
        "All tests pass",
        "",
        "## Verification",
        "bun run test",
        "",
        "## Boundaries",
        "Only touch src/parser",
        "",
        "## Stop conditions",
        "Attempt cap: 5 attempts",
        "Stop on a failing migration",
      ].join("\n"),
    );
  });

  test("a blank interview still builds the headings", () => {
    expect(buildGoalObjective(EMPTY_GUIDED_ANSWERS)).toContain(
      "## Stop conditions\nAttempt cap: \n",
    );
  });
});

describe("interviewDraftText", () => {
  test("is empty when nothing is answered", () => {
    expect(interviewDraftText(EMPTY_GUIDED_ANSWERS)).toBe("");
  });

  test("lists each answer under its question, in the order asked, and the budget last", () => {
    expect(interviewDraftText(answers)).toBe(
      [
        "What should omp get done?",
        "Ship the parser",
        "",
        "How will you know it is done?",
        "All tests pass",
        "",
        "What should omp run to check its own work?",
        "bun run test",
        "",
        "How many attempts may omp make before it stops?",
        "5 attempts",
        "",
        "What may omp change, and what must it leave alone?",
        "Only touch src/parser",
        "",
        "When should omp stop and ask you?",
        "Stop on a failing migration",
        "",
        "Token budget (optional)",
        "5000",
      ].join("\n"),
    );
  });

  test("the entry being typed stands in for its question's answer, so no question appears twice", () => {
    const text = interviewDraftText(
      { ...answers, verification: "old check" },
      { id: "verification", text: "  bun test src/parser  " },
    );
    expect(text).toContain("What should omp run to check its own work?\nbun test src/parser");
    expect(text).not.toContain("old check");
    expect(text.split("What should omp run to check its own work?")).toHaveLength(2);
  });

  test("an entry cleared while it was typed is left out", () => {
    const text = interviewDraftText(
      { ...EMPTY_GUIDED_ANSWERS, objective: "Ship" },
      { id: "objective", text: "   " },
    );
    expect(text).toBe("");
  });
});
