import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AnnounceProvider, useAnnounce } from "./live-region";

function Announcer() {
  const announce = useAnnounce();
  return (
    <div>
      <button type="button" onClick={() => announce("Saved politely")}>
        polite
      </button>
      <button type="button" onClick={() => announce("Critical failure", "assertive")}>
        assertive
      </button>
    </div>
  );
}

afterEach(cleanup);

describe("accessibility live-region host", () => {
  test("provides separate polite and assertive announcement channels", () => {
    render(
      <AnnounceProvider>
        <Announcer />
      </AnnounceProvider>,
    );

    act(() => screen.getByRole("button", { name: "polite" }).click());
    expect(screen.getByRole("status").textContent).toBe("Saved politely");
    expect(screen.getByRole("alert").textContent).toBe("");

    act(() => screen.getByRole("button", { name: "assertive" }).click());
    expect(screen.getByRole("status").textContent).toBe("Saved politely");
    expect(screen.getByRole("alert").textContent).toBe("Critical failure");
  });

  test("ignores empty announcements", () => {
    function EmptyAnnouncer() {
      const announce = useAnnounce();
      return (
        <button type="button" onClick={() => announce("   ")}>
          empty
        </button>
      );
    }
    render(
      <AnnounceProvider>
        <EmptyAnnouncer />
      </AnnounceProvider>,
    );
    act(() => screen.getByRole("button", { name: "empty" }).click());
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("alert").textContent).toBe("");
  });
});
