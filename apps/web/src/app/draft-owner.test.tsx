import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DraftController } from "@/modules/U2/drafts";
import { useComposerDraftOwner } from "./draft-owner";

afterEach(cleanup);

function fakeController() {
  return {
    load: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function Composer({ controller }: { readonly controller: DraftController }) {
  useComposerDraftOwner(controller);
  return null;
}

/** Lets the queued microtasks and one timer turn run. */
async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}

describe("the composer's draft owner", () => {
  test("StrictMode's simulated remount keeps the draft controller alive", async () => {
    const controller = fakeController();

    render(
      <StrictMode>
        <Composer controller={controller as unknown as DraftController} />
      </StrictMode>,
    );
    await settle();

    expect(controller.dispose).not.toHaveBeenCalled();
    expect(controller.load).toHaveBeenCalled();
  });

  test("unmounting the composer disposes its draft controller once", async () => {
    const controller = fakeController();
    const view = render(<Composer controller={controller as unknown as DraftController} />);

    view.unmount();
    await settle();

    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });
});
