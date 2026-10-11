import { cleanup, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { TurnCancelContext } from "@/modules/U1/thread";
import { ReadOnlyThread } from "../read-only-thread";

afterEach(() => cleanup());

function Probe() {
  const cancel = useContext(TurnCancelContext);
  return <p data-testid="probe">{cancel === undefined ? "none" : "given"}</p>;
}

test("a hub's read-only thread withholds the chat's stop from the cards inside it", () => {
  render(
    <TurnCancelContext.Provider value={vi.fn(async () => undefined)}>
      <ReadOnlyThread messages={[]}>
        <Probe />
      </ReadOnlyThread>
    </TurnCancelContext.Provider>,
  );
  expect(screen.getByTestId("probe").textContent).toBe("none");
});
