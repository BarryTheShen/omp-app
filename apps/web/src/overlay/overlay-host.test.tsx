import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FocusScope } from "./focus-scope";
import { OVERLAY_GRAMMAR, OVERLAY_Z_INDEX } from "./grammar";
import {
  OverlayHost,
  type OverlayHostApi,
  type OverlayOpenResult,
  useOverlayHost,
  useStableOverlayHost,
} from "./overlay-host";

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
      outsidePress: "close",
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

  test("a modal closed while it waits its turn is dropped, and the next one takes the place of the one that closes", async () => {
    // The issue's steps through the host's API: open A, B and C; close B while it waits; close A with Escape.
    let latest: OverlayHostApi | undefined;
    function HostHandle() {
      latest = useOverlayHost();
      return null;
    }
    renderHost(<HostHandle />);
    const host = (): OverlayHostApi => {
      if (!latest) throw new Error("The overlay host has not rendered.");
      return latest;
    };

    const opened: OverlayOpenResult[] = [];
    act(() => {
      for (const label of ["First", "Second", "Third"]) {
        opened.push(
          host().open({
            kind: "modal",
            label,
            content: <button type="button">{label} modal</button>,
          }),
        );
      }
    });
    const second = opened[1];
    if (!second) throw new Error("The second modal did not open.");
    expect(await screen.findByRole("button", { name: "First modal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Second modal" })).toBeNull();
    expect(host().overlays.map((overlay) => overlay.status)).toEqual(["open", "queued", "queued"]);

    act(() => host().close(second.id, "programmatic"));
    await expect(second.closed).resolves.toBe("programmatic");
    expect(host().overlays.map((overlay) => overlay.status)).toEqual(["open", "queued"]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByRole("button", { name: "Third modal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "First modal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Second modal" })).toBeNull();
    expect(host().overlays.map((overlay) => overlay.status)).toEqual(["open"]);
    expect(document.querySelector("[data-overlay-background]")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
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

  test("uses outside press by kind: popovers and modals close, toasts stay passive", async () => {
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
    fireEvent.pointerUp(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open outside-safe modal" }));
    expect(await screen.findByRole("dialog", { name: "Outside-safe" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
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

  test("lets focus move into a popup the scope opened, and pulls it back from anywhere else", async () => {
    function Fixture() {
      const [popup, setPopup] = useState(false);
      return (
        <>
          <button type="button">Page behind</button>
          <FocusScope trapped>
            <button type="button" onClick={() => setPopup(true)}>
              Open list
            </button>
            {popup
              ? createPortal(
                  <div data-base-ui-portal="">
                    <button type="button">Low</button>
                  </div>,
                  document.body,
                )
              : null}
          </FocusScope>
        </>
      );
    }

    render(<Fixture />);
    const open = screen.getByRole("button", { name: "Open list" });
    await waitFor(() => expect(document.activeElement).toBe(open));
    fireEvent.click(open);
    const low = await screen.findByRole("button", { name: "Low" });
    low.focus();
    // Focus stays in the popup: it is the scope's own.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(low);
    // Focus on the page behind the scope is pulled back inside.
    screen.getByRole("button", { name: "Page behind" }).focus();
    await waitFor(() => expect(document.activeElement).toBe(open));
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

describe("useStableOverlayHost", () => {
  test("keeps one identity while overlays open and close, and still reaches the live host", async () => {
    // A long-lived controller (the dialog host, the extension-UI router) built from useOverlayHost()
    // is rebuilt and disposed every time any overlay opens. The stable handle must not change.
    const seen = new Set<OverlayHostApi>();
    const regular = new Set<OverlayHostApi>();
    let stableHandle: OverlayHostApi | undefined;
    function Probe() {
      const stable = useStableOverlayHost();
      const live = useOverlayHost();
      seen.add(stable);
      regular.add(live);
      stableHandle = stable;
      return (
        <button type="button" onClick={() => live.open({ kind: "popover", content: <p>First</p> })}>
          Open first
        </button>
      );
    }
    renderHost(<Probe />);

    fireEvent.click(screen.getByRole("button", { name: "Open first" }));
    await screen.findByText("First");
    // The regular handle changed because an overlay opened; the stable one did not.
    expect(regular.size).toBeGreaterThan(1);
    expect(seen.size).toBe(1);

    // Calls through the stable handle reach the current host, after its API object has changed.
    stableHandle?.open({ kind: "popover", content: <p>Second</p> });
    await screen.findByText("Second");
    expect(stableHandle?.overlays.length).toBe(2);
    expect(seen.size).toBe(1);
  });
});

describe("OverlayHost updates", () => {
  test("undefined patch fields do not clear values beside a changed field", async () => {
    function UpdateFixture() {
      const host = useOverlayHost();
      return (
        <button
          type="button"
          onClick={() => {
            const result = host.open({
              kind: "modal",
              label: "Original label",
              content: <p>Original content</p>,
            });
            host.update(result.id, { label: "Updated label", content: undefined });
          }}
        >
          Open and update
        </button>
      );
    }

    renderHost(<UpdateFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open and update" }));
    const dialog = await screen.findByRole("dialog", { name: "Updated label" });
    expect(screen.getByText("Original content").closest('[role="dialog"]')).toBe(dialog);
  });
});

describe("OverlayHost outside press", () => {
  function EditingFixture({ portal = false }: { readonly portal?: boolean }) {
    const host = useOverlayHost();
    return (
      <button
        type="button"
        onClick={() =>
          host.open({
            kind: "modal",
            label: "Editing dialog",
            content: ({ close, requestClose, update }) => (
              <>
                <button type="button" onClick={() => update({ unsavedChanges: true })}>
                  Make an edit
                </button>
                <button type="button" onClick={() => requestClose()}>
                  Close with the close button
                </button>
                <button type="button" onClick={() => close()}>
                  Done
                </button>
                {portal
                  ? createPortal(<button type="button">Portal option</button>, document.body)
                  : null}
              </>
            ),
          })
        }
      >
        Open editing dialog
      </button>
    );
  }

  function backdrop(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    if (!element) throw new Error("expected the dimmed backdrop to be on the screen");
    return element;
  }

  test("a modal closes when its dimmed backdrop is pressed, and focus returns to the opener", async () => {
    renderHost(<EditingFixture />);
    const opener = screen.getByRole("button", { name: "Open editing dialog" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(backdrop());
    fireEvent.pointerUp(backdrop());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Editing dialog" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("a modal with unsaved changes asks before a press outside closes it, and Keep editing keeps it open", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make an edit" }));
    fireEvent.pointerDown(backdrop());
    fireEvent.pointerUp(backdrop());
    expect(
      await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" }),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
  });

  test("Discard changes closes the modal, and focus returns to the opener", async () => {
    renderHost(<EditingFixture />);
    const opener = screen.getByRole("button", { name: "Open editing dialog" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Make an edit" }));
    fireEvent.pointerDown(backdrop());
    fireEvent.pointerUp(backdrop());
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Editing dialog" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("the modal's own close asks only when there are unsaved changes", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close with the close button" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Editing dialog" })).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make an edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Close with the close button" }));
    expect(
      await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" }),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
  });

  test("Escape answers the discard question with Keep editing and leaves the modal open", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make an edit" }));
    fireEvent.pointerDown(backdrop());
    fireEvent.pointerUp(backdrop());
    await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
  });

  test("a press in a popup the dialog opened into a portal does not close the dialog", async () => {
    renderHost(<EditingFixture portal />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    const portalOption = await screen.findByRole("button", { name: "Portal option" });
    fireEvent.pointerDown(portalOption);
    fireEvent.pointerUp(portalOption);
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("a press that closes a popover still clicks the control it landed on", async () => {
    const onAction = vi.fn();
    function PopoverFixture() {
      const host = useOverlayHost();
      return (
        <>
          <button
            type="button"
            onClick={() => host.open({ kind: "popover", content: <div>Menu body</div> })}
          >
            Open menu
          </button>
          <button type="button" onClick={onAction}>
            Page action
          </button>
        </>
      );
    }
    renderHost(<PopoverFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await screen.findByText("Menu body");
    const action = screen.getByRole("button", { name: "Page action" });
    fireEvent.pointerDown(action);
    fireEvent.pointerUp(action);
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Menu body")).toBeNull());
  });

  test("only a primary-button click on the dimmed area closes the modal: a right or middle button press does not", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(backdrop(), { button: 2 });
    fireEvent.pointerUp(backdrop(), { button: 2 });
    fireEvent.pointerDown(backdrop(), { button: 1 });
    fireEvent.pointerUp(backdrop(), { button: 1 });
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
    fireEvent.pointerDown(backdrop(), { button: 0 });
    fireEvent.pointerUp(backdrop(), { button: 0 });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Editing dialog" })).toBeNull(),
    );
  });

  test("a press dragged away from where it began does not close the modal, even when it comes back", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(backdrop(), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(backdrop(), { clientX: 180, clientY: 100 });
    fireEvent.pointerUp(backdrop(), { clientX: 180, clientY: 100 });
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
    fireEvent.pointerDown(backdrop(), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(backdrop(), { clientX: 180, clientY: 100 });
    fireEvent.pointerMove(backdrop(), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(backdrop(), { clientX: 100, clientY: 100 });
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
  });

  test("a click with a few pixels of movement still closes the modal", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(backdrop(), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(backdrop(), { clientX: 103, clientY: 102 });
    fireEvent.pointerUp(backdrop(), { clientX: 104, clientY: 101 });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Editing dialog" })).toBeNull(),
    );
  });

  test("a press that starts on the dimmed area and is released inside the dialog does not close it", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    const dialog = await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(backdrop());
    fireEvent.pointerUp(dialog);
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
  });

  test("a press that starts inside the dialog and is released on the dimmed area does not close it", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    const dialog = await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(backdrop());
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
  });

  test("a press the browser cancels does not close the modal when the pointer is released later", async () => {
    renderHost(<EditingFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(backdrop());
    fireEvent.pointerCancel(backdrop());
    fireEvent.pointerUp(backdrop());
    expect(screen.getByRole("dialog", { name: "Editing dialog" })).toBeTruthy();
  });

  test("the click a dimmed-area release makes does not reach the page behind the modal", async () => {
    const onPageAction = vi.fn();
    renderHost(
      <>
        <EditingFixture />
        <button type="button" onClick={onPageAction}>
          Page action
        </button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open editing dialog" }));
    await screen.findByRole("dialog", { name: "Editing dialog" });
    fireEvent.pointerDown(backdrop());
    fireEvent.pointerUp(backdrop());
    fireEvent.click(screen.getByRole("button", { name: "Page action" }));
    expect(onPageAction).not.toHaveBeenCalled();
  });
});
