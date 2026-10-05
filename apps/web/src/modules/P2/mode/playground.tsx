import { ThreadId } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { PlanDocumentStoreSource } from "../contract";
import { PlanModeController } from "./mode";
import { PlanModeStatus } from "./status";

const threadId = ThreadId.parse("p2-mode-playground");
const planDocument = {
  id: "plan-playground",
  threadId,
  markdown: "# Plan\n\nDraft host-owned planning document.\n",
  sections: [{ id: "plan", heading: "Plan", start: 0, end: 3 }],
  annotations: [],
  status: "draft" as const,
  revision: 1,
  updatedAt: "2026-10-05T00:00:00.000Z",
};

function createStore(): PlanDocumentStoreSource {
  return {
    load: async () => ({ document: planDocument, revisions: [] }),
    save: async (input, expectedRevision) => ({
      document: { ...input, revision: expectedRevision + 1, updatedAt: "2026-10-05T00:00:01.000Z" },
      revisions: [],
    }),
    export: async (documentId, format) => ({ documentId, format, text: planDocument.markdown }),
    subscribeChanged: () => () => undefined,
  };
}

function Playground() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement?.classList.contains("dark") ? "dark" : "light",
  );
  const controllerRef = useRef<PlanModeController | null>(null);
  if (controllerRef.current === null)
    controllerRef.current = new PlanModeController({ store: createStore(), threadId });
  const controller = controllerRef.current;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("dark", theme === "dark");
    return () => root.classList.remove("dark");
  }, [theme]);
  useEffect(() => {
    void controller.load().then(() => setLoaded(true));
    return () => controller.dispose();
  }, [controller]);
  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="p2-mode-playground">
      <header className="border-border flex min-h-14 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">P2.2</p>
          <h1 className="text-sm font-semibold">Plan mode status</h1>
        </div>
        <div className="flex gap-2">
          <Button
            data-testid="theme-light"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setTheme("light")}
          >
            Light
          </Button>
          <Button
            data-testid="theme-dark"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setTheme("dark")}
          >
            Dark
          </Button>
        </div>
      </header>
      <section className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="border-border bg-card rounded-xl border p-5 shadow-sm">
          {loaded ? <PlanModeStatus controller={controller} /> : <p role="status">Loading plan…</p>}
          <p className="text-muted-foreground mt-4 text-sm">
            Your plan drafts are saved; switching plan mode waits for support in omp.
          </p>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("p2-mode-playground-root");
if (!root) throw new Error("P2.2 playground root is missing.");
createRoot(root).render(<Playground />);
