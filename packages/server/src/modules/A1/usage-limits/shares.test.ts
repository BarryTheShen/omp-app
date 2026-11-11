import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadId, UsageLimitsResult } from "@omp-app/contracts";
import type { ChatEvent } from "@omp-app/contracts/chat-host";
import { UsageShares } from "./shares";

const MIN = 60_000;
const START = Date.parse("2026-11-11T08:00:00Z");
const RESET = START + 4 * 60 * MIN;
const FIVE_HOURS = 5 * 60 * MIN;
const A = "chat-a" as ThreadId;
const B = "chat-b" as ThreadId;

let folder: string | null = null;
afterEach(async () => {
  if (folder !== null) await rm(folder, { recursive: true, force: true });
  folder = null;
});

/** One read: anthropic's 5-hour window at `used` percent, resetting at `resetsAt`; with `accounts`, theirs together. */
const read = (
  used: number,
  resetsAt = RESET,
  accounts?: { readonly count: number; readonly usedAccounts: number },
): UsageLimitsResult => ({
  state: "ready",
  fetchedAt: new Date(START).toISOString(),
  providers: [
    {
      providerId: "anthropic",
      windows: [
        {
          label: "5 Hour",
          usedPercent: used,
          resetsAt: new Date(resetsAt).toISOString(),
          accounts: accounts?.count ?? 1,
          durationMs: FIVE_HOURS,
          ...(accounts === undefined ? {} : { usedAccounts: accounts.usedAccounts }),
        },
      ],
    },
  ],
});

/** A reply of `provider`'s model that cost `cost` dollars for `tokens` tokens. */
const reply = (cost: number, tokens = 1_000, provider = "anthropic"): ChatEvent =>
  ({
    type: "message_end",
    messageId: "m",
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider,
      model: "claude",
      stopReason: "stop",
      timestamp: START,
      usage: {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  }) as unknown as ChatEvent;

async function open(clock: { at: number }): Promise<UsageShares> {
  folder ??= await mkdtemp(join(tmpdir(), "omp-app-shares-"));
  return UsageShares.open(join(folder, "usage-shares.json"), { now: () => clock.at });
}

const parts = (shares: UsageShares) =>
  Object.fromEntries(
    (shares.snapshot().providers[0]?.chats ?? []).map((chat) => [chat.threadId, chat.share]),
  );

describe("each chat's part of its provider's 5-hour window (#14)", () => {
  test("a reading's growth goes to the chats by what each spent; the use before the first reading is outside", async () => {
    const clock = { at: START };
    const shares = await open(clock);
    shares.onReading(read(10));
    shares.onEvent(A, reply(3));
    shares.onEvent(B, reply(1));
    clock.at += 5 * MIN;
    shares.onReading(read(30));
    expect(parts(shares)).toEqual({ [A]: 15, [B]: 5 });
    expect(shares.snapshot().providers[0]).toMatchObject({ used: 30, outside: 10, since: START });
    expect(shares.shareOf(A, "anthropic")).toBe(15);
    expect(shares.shareOf(B)).toBe(5);
  });

  test("growth while no chat spent is outside the app; spend on another provider counts there only", async () => {
    const clock = { at: START };
    const shares = await open(clock);
    shares.onReading(read(10));
    shares.onEvent(A, reply(2, 1_000, "openai-codex"));
    clock.at += 5 * MIN;
    shares.onReading(read(18));
    expect(parts(shares)).toEqual({});
    expect(shares.snapshot().providers[0]).toMatchObject({ used: 18, outside: 18 });
  });

  test("a window whose percent falls, or whose reset has passed, starts over", async () => {
    const clock = { at: START };
    const shares = await open(clock);
    shares.onReading(read(40));
    shares.onEvent(A, reply(1));
    clock.at += 5 * MIN;
    shares.onReading(read(60));
    expect(parts(shares)).toEqual({ [A]: 20 });
    // The reset passed: the new window's use is the chats' that spent since.
    clock.at = RESET + MIN;
    shares.onEvent(B, reply(1));
    shares.onReading(read(4, RESET + FIVE_HOURS));
    expect(parts(shares)).toEqual({ [B]: 4 });
    expect(shares.snapshot().providers[0]).toMatchObject({ outside: 0, since: RESET });
    // The percent fell without a reset said (an account's window reset): it starts over too.
    clock.at += 5 * MIN;
    shares.onEvent(A, reply(1));
    shares.onReading(read(2, RESET + FIVE_HOURS));
    expect(parts(shares)).toEqual({ [A]: 2 });
  });

  test("two accounts count together: their shares added up, over how many there are", async () => {
    const clock = { at: START };
    const shares = await open(clock);
    shares.onReading(read(95, RESET, { count: 2, usedAccounts: 0.6 }));
    shares.onEvent(A, reply(1));
    clock.at += 5 * MIN;
    shares.onReading(read(95, RESET, { count: 2, usedAccounts: 1 }));
    expect(parts(shares)).toEqual({ [A]: 20 });
    expect(shares.snapshot().providers[0]?.used).toBe(50);
  });

  test("replies with no price weigh by their tokens", async () => {
    const clock = { at: START };
    const shares = await open(clock);
    shares.onReading(read(0));
    shares.onEvent(A, reply(0, 3_000));
    shares.onEvent(B, reply(0, 1_000));
    clock.at += 5 * MIN;
    shares.onReading(read(8));
    expect(parts(shares)).toEqual({ [A]: 6, [B]: 2 });
  });

  test("the parts, and spend not yet read, are kept across a restart", async () => {
    const clock = { at: START };
    const shares = await open(clock);
    shares.onReading(read(10));
    shares.onEvent(A, reply(1));
    clock.at += 5 * MIN;
    shares.onReading(read(20));
    shares.onEvent(B, reply(1));
    await shares.saved();
    const again = await open(clock);
    expect(again.snapshot()).toEqual(shares.snapshot());
    clock.at += 5 * MIN;
    again.onReading(read(26));
    expect(parts(again)).toEqual({ [A]: 10, [B]: 6 });
  });
});
