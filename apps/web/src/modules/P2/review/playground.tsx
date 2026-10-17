import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { PlanDocument } from "../contract";
import { PlanReviewPanel } from "./index";

const planDocument: PlanDocument = {
  id: "plan-review-playground",
  threadId: "thread-plan-review" as PlanDocument["threadId"],
  markdown: `# Delivery plan

A long-form plan for reviewing the navigation, copy and export controls.

## Goals

Keep every section readable at desktop and phone widths. Use the table of contents to move directly to a section.

## Milestones

### Foundation

Keep the implementation small, typed and compatible with the current plan.

### Delivery

Confirm the changes with unit tests and the browser check before shipping.

## Risks

Long section names remain readable in the navigation, and links are rendered as safe https links.

## Validation

1. Review the whole plan.
2. Jump to each heading using the table of contents.
3. Copy or export and confirm the visible result.

## Rollback

Revert this feature commit to restore the previous plan review experience.
`,
  sections: [
    { id: "delivery-plan", heading: "Delivery plan", start: 0, end: 3 },
    { id: "goals", heading: "Goals", start: 4, end: 8 },
    { id: "milestones", heading: "Milestones", start: 8, end: 10 },
    { id: "foundation", heading: "Foundation", start: 10, end: 14 },
    { id: "delivery", heading: "Delivery", start: 14, end: 18 },
    { id: "risks", heading: "Risks", start: 18, end: 22 },
    { id: "validation", heading: "Validation", start: 22, end: 28 },
    { id: "rollback", heading: "Rollback", start: 28, end: 32 },
  ],
  annotations: [],
  status: "review",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function copyPlan(markdown: string): Promise<void> {
  await window.navigator.clipboard.writeText(markdown);
}

function exportPlan(format: "markdown" | "json"): void {
  const contents =
    format === "markdown" ? planDocument.markdown : JSON.stringify(planDocument, null, 2);
  const type = format === "markdown" ? "text/markdown" : "application/json";
  const download = new Blob([contents], { type });
  const url = URL.createObjectURL(download);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = `plan.${format === "markdown" ? "md" : "json"}`;
  link.click();
  URL.revokeObjectURL(url);
}

function Playground() {
  const setTheme = (theme: "light" | "dark") => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  };

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="p2-review-playground">
      <header className="border-border flex min-h-12 items-center justify-between border-b px-4">
        <h1 className="text-sm font-semibold">Plan review playground</h1>
        <div className="flex gap-2">
          <Button
            data-testid="theme-light"
            size="sm"
            type="button"
            onClick={() => setTheme("light")}
          >
            Light
          </Button>
          <Button data-testid="theme-dark" size="sm" type="button" onClick={() => setTheme("dark")}>
            Dark
          </Button>
        </div>
      </header>
      <aside className="border-sidebar-border bg-sidebar fixed inset-y-12 end-0 flex w-full max-w-md border-s shadow-overlay">
        <PlanReviewPanel document={planDocument} open onCopy={copyPlan} onExport={exportPlan} />
      </aside>
    </main>
  );
}

const root = window.document.getElementById("p2-review-playground-root");
if (!root) throw new Error("P2.3 review playground root is missing.");
createRoot(root).render(<Playground />);
