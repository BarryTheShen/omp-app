import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createUnavailableCollaborationPort } from "../contract/contract";
import { CollaborationPanel } from "./index";

const root = document.getElementById("i4-collaboration-playground-root");
if (!root) throw new Error("The collaboration playground root is missing.");

function CollaborationPlayground() {
  const [open, setOpen] = useState(true);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <button
        className="m-4 rounded border px-3 py-2 text-sm underline"
        id="collaboration-opener"
        onClick={() => setOpen(true)}
        type="button"
      >
        Open collaboration
      </button>
      <aside
        className="border-sidebar-border bg-sidebar flex min-h-screen w-full max-w-md border-e shadow-overlay"
        data-u0-right-sidebar="true"
      >
        <CollaborationPanel
          invokingFocus="collaboration-opener"
          onOpenChange={(next) => setOpen(next)}
          open={open}
          restoreFocus={(token) => document.getElementById(token)?.focus()}
          snapshot={createUnavailableCollaborationPort().readOnlySession.getSnapshot()}
        />
      </aside>
    </main>
  );
}

createRoot(root).render(<CollaborationPlayground />);
