import { describe, expect, test } from "vitest";
import { GIVE_UP_AFTER_MS, RETRY_AFTER_MS, type ReloadDeps, watchReload } from "./pageReload";

/** A page whose reload never lands: a clock moved by hand, and what the reload did to it. */
function stalledPage() {
  let now = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  const did: string[] = [];
  const kept: unknown[] = [];
  const deps: ReloadDeps = {
    reload: () => did.push("reload"),
    replace: (href) => did.push(`replace ${href}`),
    href: () => "https://app.example/#chat=abc",
    now: () => now,
    later: (run, ms) => timers.push({ at: now + ms, run }),
    keep: (started) => kept.push(started),
    tell: (stage, _how, marks) => did.push(`tell ${stage} ${JSON.stringify(marks)}`),
    askToReopen: () => did.push("ask to reopen"),
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.run();
    }
    now = until;
  };
  return { deps, did, kept, advance };
}

describe("a watched reload", () => {
  test("that never lands is tried afresh after 8 s, keeping the address, then asks to reopen at 20 s", () => {
    const page = stalledPage();
    watchReload("closed", page.deps);
    expect(page.did).toEqual(["tell start {}", "reload"]);

    page.advance(RETRY_AFTER_MS - 1);
    expect(page.did).toHaveLength(2);
    page.advance(1);
    expect(page.did.slice(2)).toEqual([
      `tell stalled {"after_ms":${RETRY_AFTER_MS}}`,
      `replace https://app.example/?reload=${1_000 + RETRY_AFTER_MS}#chat=abc`,
    ]);
    expect(page.kept.at(-1)).toEqual({ at: 1_000, how: "closed", retried: true });

    page.advance(GIVE_UP_AFTER_MS - RETRY_AFTER_MS);
    expect(page.did.slice(4)).toEqual([
      `tell stuck {"after_ms":${GIVE_UP_AFTER_MS}}`,
      "ask to reopen",
    ]);
  });
});
