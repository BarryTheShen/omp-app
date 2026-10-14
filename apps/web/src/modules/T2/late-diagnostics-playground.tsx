import { createRoot } from "react-dom/client";
import "../../index.css";
import { LateDiagnosticsCard } from "./late-diagnostics";

/** Seven warnings after one error in one file: the card lists five lines, and "Show more" reveals the rest. */
const cartLines = [
  "cart.ts:41:9 [error] [typescript] Property 'total' does not exist (2339)",
  ...Array.from(
    { length: 7 },
    (_, index) =>
      `cart.ts:${10 + index}:3 [warning] [typescript] Unused variable number ${index + 1} (6133)`,
  ),
];

function LateDiagnosticsPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t2-late-diagnostics-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">Late diagnostics</h1>
        <p className="text-muted-foreground text-sm">
          What omp reported after an edit or write finished
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <LateDiagnosticsCard
          identity="late-attached"
          snapshot={{
            customType: "lsp-late-diagnostic",
            relatedToolCallId: "call-edit-7",
            details: {
              files: [
                {
                  path: "/tmp/cart.ts",
                  summary: "1 error(s)",
                  errored: true,
                  messages: cartLines,
                },
                {
                  path: "/tmp/tax.ts",
                  summary: "no issues",
                  errored: false,
                  messages: [],
                },
              ],
            },
          }}
        />
        <LateDiagnosticsCard
          identity="late-empty"
          snapshot={{ customType: "lsp-late-diagnostic", details: { files: [] } }}
        />
        <LateDiagnosticsCard
          identity="late-malformed"
          snapshot={{ customType: "lsp-late-diagnostic" }}
        />
        <LateDiagnosticsCard
          identity="late-markup"
          snapshot={{
            customType: "lsp-late-diagnostic",
            details: {
              files: [
                {
                  path: "notes.md",
                  summary: "1 hint(s)",
                  errored: false,
                  messages: ["notes.md:4:1 [hint] <b>not bold</b> & kept as text"],
                },
              ],
            },
          }}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("t2-late-diagnostics-playground-root") as HTMLElement).render(
  <LateDiagnosticsPlayground />,
);
