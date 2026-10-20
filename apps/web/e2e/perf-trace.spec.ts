import { expect, realTest, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

function traceLines(realApp: { log: () => string }): readonly string[] {
  return realApp
    .log()
    .split("\n")
    .filter((line) => /\btrace\b/.test(line));
}
realTest.describe("opt-in performance trace", () => {
  realTest("one open writes one numeric trace line when enabled", async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.perf", "1")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await expect.poll(() => traceLines(realApp).length, { timeout: 30_000 }).toBe(1);
    const line = traceLines(realApp)[0];
    if (line === undefined) throw new Error("The enabled trace line is missing");
    const marks = new Map(
      [...line.matchAll(/mark_([a-z0-9_]+)=([0-9.]+)/gu)].map((match) => [
        match[1] ?? "",
        Number(match[2]),
      ]),
    );
    const click = marks.get("click");
    expect(typeof click).toBe("number");
    for (const name of [
      "data_app_root_visible",
      "first_feedback",
      "rpc_open_returned",
      "window_applied",
      "newest_20_painted",
      "composer_typable",
      "list_rows_visible",
      "send_accepted",
      "send_delivered",
    ]) {
      const time = marks.get(name);
      expect(typeof time, `trace includes ${name}`).toBe("number");
      if (name !== "data_app_root_visible")
        expect(time, `${name} is later than the open action`).toBeGreaterThan(click ?? 0);
    }
    expect(marks.has("leaf_swap")).toBe(false);
    expect(line).toMatch(/supported=/);
    expect(line).not.toMatch(/session|thread|workspace|path|prompt|message/i);
  });

  realTest("one open writes no trace line when disabled", async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    await waitForFiniteAnimations(page);
    await page.waitForTimeout(3_500);
    expect(traceLines(realApp)).toEqual([]);
  });
});
