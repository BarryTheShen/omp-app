import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { formData, readForm, untouchedFormData } from "./form";

const scratch = join(globalThis.process.cwd(), ".data", `form-${crypto.randomUUID()}`);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A 1×1 PNG. */
const PNG = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
);

/** A form a model could write, with everything a page must never run. */
const FORM = `
<link rel="stylesheet" href="https://example.com/remote.css">
<style>body { background: url(https://example.com/track.png) }</style>
<script>alert("from the form")</script>
<form onsubmit="alert('submit')">
  <fieldset>
    <legend>Database</legend>
    <p onclick="alert('click')">Which <strong>database</strong>?</p>
    <label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="db" value="pg"> Postgres</label>
  </fieldset>
  <img src="diagram.png" alt="The diagram" onerror="alert('error')">
  <svg viewBox="0 0 10 10"><script>alert("svg")</script><rect width="10" height="10"/></svg>
  <p>Extras</p>
  <label><input type="checkbox" name="extras" value="cache"> Cache</label>
  <label><input type="checkbox" name="extras" value="logs"> Logs</label>
  <label>Workers <input type="number" name="workers" min="1" max="8" value="2" required></label>
  <label>Notes <textarea name="notes" rows="3"></textarea></label>
  <input type="hidden" name="form" value="setup">
  <button type="submit">Go</button>
</form>`;

describe("omp's question form in the app", () => {
  test("reaches the page as text, pictures and fields: no script, handler or style of the form", async () => {
    await mkdir(scratch, { recursive: true });
    await Bun.write(join(scratch, "diagram.png"), PNG);
    const { dialog } = await readForm(FORM, scratch);
    const sent = JSON.stringify(dialog);
    for (const banned of [
      "<",
      "alert",
      "onclick",
      "onerror",
      "onsubmit",
      "example.com",
      "stylesheet",
    ]) {
      expect(sent).not.toContain(banned);
    }
    const blocks = dialog.sections.flatMap((section) => section.blocks);
    const pictures = blocks.filter((block) => block.kind === "image");
    // The relative picture is read from the chat's folder; the drawing becomes a picture, which a page never runs.
    expect(
      pictures.map((block) => (block.kind === "image" ? block.src?.slice(0, 26) : "")),
    ).toEqual(["data:image/png;base64,iVBO", "data:image/svg+xml;base64,"]);
    expect(dialog.fields.map((field) => field.kind)).toEqual(["choice", "choice", "text", "text"]);
    const [db, extras, workers, notes] = dialog.fields;
    expect(db).toMatchObject({ multi: false, other: true, required: false });
    expect(db?.kind === "choice" && db.options.map((option) => option.checked)).toEqual([
      true,
      false,
    ]);
    expect(extras).toMatchObject({ multi: true, other: true });
    expect(workers).toMatchObject({ type: "number", min: 1, max: 8, value: "2", required: true });
    expect(notes).toMatchObject({ multiline: true, rows: 3 });
  });

  test("a picture that cannot be read shows as its words", async () => {
    const { dialog } = await readForm(
      `<form><img src="missing.png" alt="Missing"><input name="a"></form>`,
      scratch,
    );
    expect(dialog.sections[0]?.blocks[0]).toEqual({ kind: "image", src: null, alt: "Missing" });
  });

  test("the answer becomes omp's form data, by omp's rules", async () => {
    const { form } = await readForm(FORM, scratch);
    const data = formData(form, [
      // Other… typed in place of a round mark's value.
      { checked: [], other: "  DuckDB " },
      // Other… joins the ticked values of tick boxes.
      { checked: [1], other: "traces" },
      { text: "4" },
      { text: "line one\nline two" },
    ]);
    expect(data).toEqual({
      form: "setup",
      db: "DuckDB",
      extras: ["logs", "traces"],
      workers: 4,
      notes: "line one\nline two",
    });
    // Untouched, the form sends what it offered.
    expect(untouchedFormData(form)).toEqual({
      form: "setup",
      db: "sqlite",
      extras: [],
      workers: 2,
      notes: "",
    });
  });

  test("an answer that does not fit the form is refused", async () => {
    const { form } = await readForm(FORM, scratch);
    expect(() => formData(form, [{ checked: [0] }])).toThrow("must carry 4 fields");
    expect(() =>
      formData(form, [{ text: "x" }, { checked: [] }, { text: "4" }, { text: "" }]),
    ).toThrow("db takes some of its 2 options");
    expect(() =>
      formData(form, [{ checked: [5] }, { checked: [] }, { text: "4" }, { text: "" }]),
    ).toThrow("db takes some of its 2 options");
  });
});
