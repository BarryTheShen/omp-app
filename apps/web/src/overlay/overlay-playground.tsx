import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { OverlayHost, useOverlayHost } from "./index";

function OverlayPlayground() {
  const host = useOverlayHost();
  const [lastClosed, setLastClosed] = useState("Nothing closed yet");

  const openModal = () => {
    const result = host.open({
      kind: "modal",
      label: "Approval dialog",
      content: ({ close }) => (
        <div className="flex flex-col gap-4" data-testid="modal-body">
          <div>
            <h2 className="text-lg font-medium">Approval dialog</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              The background is inert while this question is open.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border bg-primary px-3 py-2 text-sm text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => close()}
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => close()}
            >
              Deny
            </button>
          </div>
        </div>
      ),
    });
    void result.closed.then(setLastClosed);
  };
  const openPopover = () => {
    let popoverId = "";
    const result = host.open({
      kind: "popover",
      content: (
        <div className="flex flex-col gap-1 p-2" data-testid="popover-body">
          <strong className="px-2 py-1 text-sm font-medium">Quick actions</strong>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-start text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => host.close(popoverId)}
          >
            Open settings
          </button>
        </div>
      ),
    });
    popoverId = result.id;
    void result.closed.then(setLastClosed);
  };

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="overlay-playground">
      <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">omp</p>
          <h1 className="text-xl font-semibold">Overlay playground</h1>
        </div>
        <p className="text-muted-foreground text-sm" data-testid="last-closed">
          {lastClosed}
        </p>
      </header>
      <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
        <div className="border-border bg-card rounded-xl border p-6 shadow-sm">
          <p className="text-muted-foreground text-sm">Thread transcript</p>
          <p className="mt-2 text-base">
            Overlay interactions stay keyboard-first and serving-independent.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            id="modal-opener"
            type="button"
            className="rounded-md border border-border bg-primary px-3 py-2 text-sm text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={openModal}
          >
            Open modal
          </button>
          <button
            id="popover-opener"
            type="button"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={openPopover}
          >
            Open popover
          </button>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("overlay-playground-root");
if (!root) throw new Error("Overlay playground root is missing.");

// StrictMode, as in main.tsx: development double-invokes effects, which once broke focus restore.
createRoot(root).render(
  <StrictMode>
    <OverlayHost>
      <OverlayPlayground />
    </OverlayHost>
  </StrictMode>,
);
