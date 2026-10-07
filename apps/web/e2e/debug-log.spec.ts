import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/**
 * Feedback: 'make sure debug logs are readily available, so I can attach them when things crash'.
 * A real chat on real omp leaves the lines the issue promises in the log, and nothing the log must
 * never hold: the launch token, the API key, or the words of the prompt.
 */
realTest(
  "a real chat leaves the promised lines in the debug log, and no secret",
  async ({ realApp }) => {
    const secretWords = "my-private-launch-codes-are-swordfish";
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, `ping ${secretWords}`);
    await expect(
      page
        .locator('[data-slot="u1-message-row"][data-role="assistant"]')
        .filter({ hasText: "pong" }),
    ).toHaveCount(1, { timeout: 45_000 });
    // Wait for a periodic sample that sees the running omp (the harness samples every second).
    await expect
      .poll(() => /stats .*omp_count=1/.test(realApp.log()), { timeout: 15_000 })
      .toBe(true);
    await page.close();
    await expect
      .poll(() => realApp.log().includes("connection.close"), { timeout: 15_000 })
      .toBe(true);

    const log = realApp.log();
    const lines = log.split("\n").filter((line) => line.length > 0);
    // The header: version, system, versions, folders.
    expect(lines[0]).toMatch(/ INFO {2}start /);
    expect(log).toMatch(/start version=\S+ pid=\d+ platform=linux os_release=\S+ arch=\S+ bun=\S+/);
    expect(log).toContain(`folder=${realApp.folder}`);
    // The omp probe and the capability probe, with timings.
    expect(log).toMatch(/ INFO {2}omp\.probe status=ok version=\d+\.\d+\.\d+ ms=\d+/);
    expect(log).toMatch(
      / INFO {2}capabilities\.probe protocol=\d available=\d+ unavailable=\d+ ms=\d+/,
    );
    expect(log).toMatch(/ INFO {2}listening port=\d+ health=ok/);
    // The omp process: created, running with its pid.
    expect(log).toMatch(/omp\.process\.created thread=\S+ folder=/);
    expect(log).toMatch(/omp\.process thread=\S+ status=running pid=\d+/);
    // The browser connection.
    expect(log).toMatch(/ INFO {2}connection\.open id=\w{8} total=\d+/);
    expect(log).toMatch(/ INFO {2}connection\.close id=\w{8}/);
    // A periodic sample: memory, the omp processes, and the event-loop delay.
    expect(log).toMatch(
      / INFO {2}stats uptime_s=\d+ rss_mb=\d+ heap_mb=\d+ external_mb=\d+ free_mb=\d+ load1=[\d.]+ loop_lag_ms=\d+ omp_count=1 omp_rss_mb=\d+ omp_max_mb=\d+ omp_pids=\d+/,
    );

    // Never in the log: this run's launch token, the key omp was given, the words of the prompt.
    expect(realApp.token.length).toBeGreaterThan(20);
    expect(log).not.toContain(realApp.token);
    expect(log).not.toContain("swordfish");
    expect(log).not.toContain(secretWords);
    expect(log).not.toMatch(new RegExp(["sk", "ant", "k{10,}"].join("-")));
    expect(log).not.toMatch(/token=[A-Za-z0-9_-]{20,}/);
  },
);
