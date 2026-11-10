import type { FormChoiceField, FormDialog, FormTextField } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { fieldError, formAnswer, formErrors, initialValues } from "./form-answer";

const option = (text: string, checked = false, disabled = false) => ({
  label: [{ text }],
  checked,
  disabled,
});

const radios: FormChoiceField = {
  kind: "choice",
  question: "Which database?",
  multi: false,
  select: false,
  other: true,
  label: [],
  options: [option("SQLite", true), option("Postgres")],
  required: true,
};
const boxes: FormChoiceField = {
  kind: "choice",
  question: "Extras",
  multi: true,
  select: false,
  other: true,
  label: [],
  options: [option("Cache", true), option("Logs", false, true), option("Traces")],
  required: true,
};
const workers: FormTextField = {
  kind: "text",
  question: "Workers",
  type: "number",
  multiline: false,
  label: [{ text: "Workers" }],
  value: "2",
  placeholder: "",
  required: true,
  min: 1,
  max: 8,
  rows: 1,
};
const dialog: FormDialog = {
  sections: [{ title: [], blocks: [0, 1, 2].map((index) => ({ kind: "field" as const, index })) }],
  fields: [radios, boxes, workers],
};

describe("omp's form on the card", () => {
  test("opens with what the form ticks and fills in", () => {
    expect(initialValues(dialog)).toEqual([
      { checked: [0], other: undefined },
      { checked: [0], other: undefined },
      { text: "2" },
    ]);
    // A round mark takes one answer: the first the form ticks.
    expect(
      initialValues({
        ...dialog,
        fields: [{ ...radios, options: [option("A", true), option("B", true)] }],
      }),
    ).toEqual([{ checked: [0], other: undefined }]);
  });

  test("refuses what omp refuses, in omp's words", () => {
    expect(fieldError(radios, { checked: [], other: undefined })).toBe("Required");
    expect(fieldError(boxes, { checked: [], other: undefined })).toBe("Select at least one");
    // An option that cannot be picked is no answer; blank Other… text is none either.
    expect(fieldError(boxes, { checked: [1], other: "  " })).toBe("Select at least one");
    expect(fieldError(boxes, { checked: [], other: "Metrics" })).toBeUndefined();
    expect(fieldError(workers, { text: "" })).toBe("Required");
    expect(fieldError(workers, { text: "many" })).toBe("Enter a number");
    expect(fieldError(workers, { text: "9" })).toBe("Must be at most 8");
    expect(
      fieldError({ ...workers, type: "email", min: undefined, max: undefined }, { text: "me" }),
    ).toBe("Enter an email address");
    expect(fieldError({ ...workers, type: "text", pattern: "[a-z]+" }, { text: "abc1" })).toBe(
      "Must match [a-z]+",
    );
    expect(
      formErrors(dialog, [
        { checked: [], other: undefined },
        { checked: [2], other: undefined },
        { text: "0" },
      ]),
    ).toEqual(
      new Map([
        [0, "Required"],
        [2, "Must be at least 1"],
      ]),
    );
  });

  test("answers each field in the form's order; Other… only where omp offers it", () => {
    expect(
      formAnswer(dialog, [
        { checked: [], other: "DuckDB" },
        { checked: [0, 2], other: undefined },
        { text: "4" },
      ]),
    ).toEqual({ fields: [{ checked: [], other: "DuckDB" }, { checked: [0, 2] }, { text: "4" }] });
    const noOther = { ...dialog, fields: [{ ...radios, other: false }] };
    expect(formAnswer(noOther, [{ checked: [1], other: "ignored" }])).toEqual({
      fields: [{ checked: [1] }],
    });
  });
});
