import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { OverlayHost, useStableOverlayHost } from "@/overlay/overlay-host";
import { openDebugSelector } from "./debug-selector";

function DebugPlayground() {
  const overlay = useStableOverlayHost();
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <section className="mx-auto flex max-w-xl flex-col gap-4">
        <h1 className="text-xl font-semibold">Debug tools</h1>
        <p className="text-sm text-muted-foreground">
          This local showcase keeps terminal-only diagnostics unavailable.
        </p>
        <Button onClick={() => openDebugSelector(overlay)} type="button">
          Open debug tools
        </Button>
      </section>
    </main>
  );
}

export function DebugPlaygroundApp() {
  return (
    <OverlayHost>
      <DebugPlayground />
    </OverlayHost>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The debug playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <DebugPlaygroundApp />
  </StrictMode>,
);
