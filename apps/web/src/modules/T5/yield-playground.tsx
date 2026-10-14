import { createRoot } from "react-dom/client";
import "../../index.css";
import { YieldToolRenderer } from "./yield";
import { YIELD_FIXTURES, yieldRendererProps } from "./yield-fixtures";

function YieldPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t5-yield-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T5.5 Yield card</h1>
        <p className="text-muted-foreground text-sm">
          Submitted output, sections, outcomes and failures, in the shapes omp returns
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        {YIELD_FIXTURES.map((fixture) => (
          <div className="flex min-w-0 flex-col gap-2" key={fixture.id}>
            <h2 className="text-muted-foreground text-xs font-medium">{fixture.title}</h2>
            <YieldToolRenderer {...yieldRendererProps(fixture)} />
          </div>
        ))}
      </section>
    </main>
  );
}

const root = document.getElementById("t5-yield-playground-root");
if (!root) throw new Error("T5.5 yield playground root is missing.");
createRoot(root).render(<YieldPlayground />);
