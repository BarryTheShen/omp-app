import type { AppHealth } from "@omp-app/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useWatchNotice, WatchNotice, watchNoticeFor } from "./watch-notice";

const LIMITED_DETAIL =
  "omp app can't watch some of its files for changes, because this computer has no file watchers left. Closing programs that watch many files, such as editors, may free some. It checks them every second instead, so changes still show, a little later.";
const LIMITED: AppHealth = { status: "degraded", code: "watch_limited", detail: LIMITED_DETAIL };
const OK: AppHealth = { status: "ok" };
const WATCH_FAILED_DETAIL =
  "omp app can't watch some of its files for changes. It checks them every second instead, so changes still show, a little later.";
const WATCH_FAILED: AppHealth = {
  status: "degraded",
  code: "watch_limited",
  detail: WATCH_FAILED_DETAIL,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WatchNotice", () => {
  test("shows the server's words and can be dismissed", async () => {
    vi.useFakeTimers();
    let answer: AppHealth = LIMITED;
    const readHealth = vi.fn(async () => answer);
    const view = render(<NoticeProbe chatId="first" readHealth={readHealth} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status").textContent).toContain(LIMITED_DETAIL);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Dismiss" }).click());
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<NoticeProbe chatId="second" readHealth={readHealth} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByRole("status")).toBeNull();

    answer = OK;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    answer = LIMITED;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("status").textContent).toContain(LIMITED_DETAIL);
    expect(readHealth).toHaveBeenCalledTimes(4);
  });

  test("does not add the watcher-limit remedy to another server reason", async () => {
    vi.useFakeTimers();
    const readHealth = vi.fn(async () => WATCH_FAILED);
    render(<NoticeProbe readHealth={readHealth} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(WATCH_FAILED_DETAIL, { exact: true })).toBeTruthy();
  });
});

describe("watchNoticeFor", () => {
  test("gives the server's words only while a watch is limited", () => {
    expect(watchNoticeFor(LIMITED)).toBe(LIMITED_DETAIL);
    expect(watchNoticeFor(WATCH_FAILED)).toBe(WATCH_FAILED_DETAIL);
    expect(watchNoticeFor(OK)).toBeUndefined();
    expect(
      watchNoticeFor({
        status: "degraded",
        code: "no_model",
        detail: "omp has no model to chat with.",
      }),
    ).toBeUndefined();
  });
});

function NoticeProbe({
  readHealth,
  chatId = "first",
}: {
  readonly readHealth?: () => Promise<AppHealth>;
  readonly chatId?: string;
}) {
  const { detail, dismiss } = useWatchNotice(readHealth, 1_000);
  return detail === undefined ? (
    <p>no notice</p>
  ) : (
    <WatchNotice key={chatId} detail={detail} onDismiss={dismiss} />
  );
}

describe("useWatchNotice", () => {
  test("shows the notice while a watch is limited, and drops it once every watch is open again", async () => {
    vi.useFakeTimers();
    let answer: AppHealth = LIMITED;
    const readHealth = vi.fn(async () => answer);
    render(<NoticeProbe readHealth={readHealth} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(LIMITED_DETAIL)).toBeTruthy();

    answer = OK;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("no notice")).toBeTruthy();
    expect(readHealth).toHaveBeenCalledTimes(2);
  });

  test("keeps the last notice when a read fails, since the connection banner covers an unreachable server", async () => {
    vi.useFakeTimers();
    let fail = false;
    const readHealth = vi.fn(async () => {
      if (fail) throw new Error("connection lost");
      return LIMITED;
    });
    render(<NoticeProbe readHealth={readHealth} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(readHealth).toHaveBeenCalledTimes(2);
    expect(screen.getByText(LIMITED_DETAIL)).toBeTruthy();
  });

  test("asks nothing while there is no client to ask", async () => {
    vi.useFakeTimers();
    render(<NoticeProbe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("no notice")).toBeTruthy();
  });
});
