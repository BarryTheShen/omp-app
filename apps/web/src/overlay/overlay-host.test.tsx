import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FocusScope } from "./focus-scope";
import { OVERLAY_GRAMMAR, OVERLAY_Z_INDEX } from "./grammar";
import { OverlayHost, type OverlayOpenResult, useOverlayHost } from "./overlay-host";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
});

function ModalFixture({ onOpened }: { onOpened?: (result: OverlayOpenResult) => void }) {
  const host = useOverlayHost();
  return (
    <button
      type="button"
      onClick={() => {
        const result = host.open({
          kind: "modal",
          label: "Example dialog",
          content: ({ close }) => (
            <>
              <button type="button">First action</button>
              <button type="button" onClick={() => close()}>
                Close dialog
              </button>
            </>
          ),
        });
        onOpened?.(result);
      }}
    >
      Open modal
    </button>
  );
}

function renderHost(children: ReactNode) {
  return render(<OverlayHost>{children}</OverlayHost>);
}

describe("overlay grammar", () => {
  test("uses one modal layer, token-backed stacking, and passive toasts", () => {
    expect(OVERLAY_GRAMMAR.modal).toMatchObject({
      focus: "trap",
      outsidePress: "ignore",
      scrollLock: true,
      inertBackground: true,
    });
    expect(OVERLAY_GRAMMAR.toast).toMatchObject({
      focus: "preserve",
      passive: true,
      outsidePress: "ignore",
    });
    expect(OVERLAY_Z_INDEX.modal).toBeGreaterThan(0);
    expect(OVERLAY_Z_INDEX.toast).toBeGreaterThan(OVERLAY_Z_INDEX.modal);
  });
});

describe("OverlayHost modal focus behavior", () => {
  test("moves focus in, traps Tab and Shift+Tab, locks scroll, and restores the opener", async () => {
    let opened: OverlayOpenResult | undefined;
    renderHost(<ModalFixture onOpened={(result) => (opened = result)} />);

    const opener = screen.getByRole("button", { name: "Open modal" });
    opener.focus();
    fireEvent.click(opener);
    const first = await screen.findByRole("button", { name: "First action" });
    expect(document.activeElement).toBe(first);
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(1);

    const close = screen.getByRole("button", { name: "Close dialog" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);

    const background = document.querySelector("[data-overlay-background]");
    expect(background).toBeTruthy();
    expect(background?.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(close);
    expect(opened).toBeDefined();
    await expect(opened?.closed).resolves.toBe("programmatic");
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.body.style.overflow).toBe("");
    expect(background?.getAttribute("aria-hidden")).toBeNull();
  });

  test("restores the opener under StrictMode, whose simulated unmount must not spend the restore", async () => {
    // main.tsx and several playgrounds render inside StrictMode. In development React mounts every
    // effect, unmounts it and mounts it again; FocusScope used to treat that fake unmount as the
    // real close, restore too early (while the background was still inert) and never again.
    let opened: OverlayOpenResult | undefined;
    render(
      <StrictMode>
        <OverlayHost>
          <ModalFixture onOpened={(result) => (opened = result)} />
        </OverlayHost>
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Open modal" });
    opener.focus();
    fireEvent.click(opener);
    const first = await screen.findByRole("button", { name: "First action" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await expect(opened?.closed).resolves.toBe("programmatic");
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("does not throw or focus a detached opener when it is removed before close", async () => {
    function RemovableFixture() {
      const host = useOverlayHost();
      const [showOpener, setShowOpener] = useState(true);
      return (
        <>
          {showOpener ? (
            <button
              type="button"
              onClick={() =>
                host.open({
                  kind: "modal",
                  content: ({ close }) => (
                    <button
                      type="button"
                      onClick={() => {
                        setShowOpener(false);
                        close();
                      }}
                    >
                      Finish
                    </button>
                  ),
                })
              }
            >
              Removable opener
            </button>
          ) : null}
        </>
      );
    }

    renderHost(<RemovableFixture />);
    const opener = screen.getByRole("button", { name: "Removable opener" });
    opener.focus();
    fireEvent.click(opener);
    const finish = await screen.findByRole("button", { name: "Finish" });
    finish.focus();
    fireEvent.click(finish);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Finish" })).toBeNull());
    expect(document.activeElement).not.toBe(opener);
  });
});

describe("OverlayHost ordering and dismissal", () => {
  test("queues a second modal and promotes it only after the first closes", async () => {
    function QueueFixture() {
      const host = useOverlayHost();
      return (
        <>
          <button
            type="button"
            onClick={() => {
              host.open({
                kind: "modal",
                label: "First",
                content: <button type="button">First modal</button>,
              });
              host.open({
                kind: "modal",
                label: "Second",
                content: <button type="button">Second modal</button>,
              });
            }}
          >
            Open modals
          </button>
          <output data-testid="overlay-state">
            {host.overlays.map((overlay) => `${overlay.id}:${overlay.status}`).join(",")}
          </output>
        </>
      );
    }

    renderHost(<QueueFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open modals" }));
    expect(await screen.findByRole("button", { name: "First modal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Second modal" })).toBeNull();
    expect(screen.getByTestId("overlay-state").textContent).toContain("queued");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("button", { name: "Second modal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "First modal" })).toBeNull();
  });

  test("Escape closes only the visible topmost overlay", async () => {
    function NestedFixture() {
      const host = useOverlayHost();
      return (
        <button
          type="button"
          onClick={() => {
            host.open({ kind: "modal", label: "Modal", content: <div>Modal body</div> });
            host.open({ kind: "menu", content: <button type="button">Menu item</button> });
          }}
        >
          Open nested overlays
        </button>
      );
    }

    renderHost(<NestedFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open nested overlays" }));
    expect(await screen.findByRole("button", { name: "Menu item" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Modal" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Menu item" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Modal" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Modal" })).toBeNull());
  });

  test("uses outside press by kind while keeping modal and toast passive", async () => {
    function DismissFixture() {
      const host = useOverlayHost();
      return (
        <>
          <button
            type="button"
            onClick={() => host.open({ kind: "toast", content: <div>Toast</div> })}
          >
            Open toast
          </button>
          <button
            type="button"
            onClick={() => host.open({ kind: "popover", content: <div>Popover</div> })}
          >
            Open popover
          </button>
          <button
            type="button"
            onClick={() =>
              host.open({ kind: "modal", label: "Outside-safe", content: <div>Modal</div> })
            }
          >
            Open outside-safe modal
          </button>
        </>
      );
    }

    renderHost(<DismissFixture />);
    const toastOpener = screen.getByRole("button", { name: "Open toast" });
    toastOpener.focus();
    fireEvent.click(toastOpener);
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("Toast");
    expect(document.activeElement).toBe(toastOpener);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const popoverOpener = screen.getByRole("button", { name: "Open popover" });
    popoverOpener.focus();
    fireEvent.click(popoverOpener);
    const popover = await screen.findByRole("dialog");
    expect(popover.textContent).toContain("Popover");
    const popoverScope = document.querySelector("[data-focus-scope]");
    expect(popoverScope).toBeTruthy();
    expect(document.activeElement).toBe(popoverScope);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open outside-safe modal" }));
    expect(await screen.findByRole("dialog", { name: "Outside-safe" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog", { name: "Outside-safe" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Outside-safe" })).toBeNull());
  });
});

describe("FocusScope", () => {
  test("restores an explicit focus target", async () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      const targetRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button type="button" ref={targetRef} onClick={() => setOpen(true)}>
            Explicit opener
          </button>
          {open ? (
            <FocusScope trapped restoreFocus={targetRef.current}>
              <button type="button" onClick={() => setOpen(false)}>
                Close scope
              </button>
            </FocusScope>
          ) : null}
        </>
      );
    }

    render(<Fixture />);
    const opener = screen.getByRole("button", { name: "Explicit opener" });
    opener.focus();
    fireEvent.click(opener);
    const close = await screen.findByRole("button", { name: "Close scope" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("reduced motion", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  test("marks open surfaces reduced-motion safe while keeping the interactive popover focusable", async () => {
    function ReducedFixture() {
      const host = useOverlayHost();
      return (
        <button
          type="button"
          onClick={() => host.open({ kind: "popover", content: <div>Reduced motion popover</div> })}
        >
          Open reduced-motion popover
        </button>
      );
    }

    renderHost(<ReducedFixture />);
    const opener = screen.getByRole("button", { name: "Open reduced-motion popover" });
    opener.focus();
    fireEvent.click(opener);
    const surface = await screen.findByRole("dialog");
    await waitFor(() => expect(surface.getAttribute("data-reduced-motion")).toBe("true"));
    const scope = document.querySelector("[data-focus-scope]");
    expect(document.activeElement).toBe(scope);
  });
});
