import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessibilityProvider } from "@/a11y/live-region";
import { AppShell } from "@/shell";
import { AppConnectionGate, AppConnectionProvider, useAppConnection } from "./app-connection";

function ConnectedShell() {
  const connection = useAppConnection();
  return (
    <AppShell
      statusBar={
        <div aria-live="polite" className="px-4 py-2 text-xs" data-testid="connection-status">
          Connected shell ({connection.state})
        </div>
      }
    />
  );
}

function LaunchPlayground() {
  return (
    <AccessibilityProvider>
      <AppConnectionProvider>
        <AppConnectionGate>
          <ConnectedShell />
        </AppConnectionGate>
      </AppConnectionProvider>
    </AccessibilityProvider>
  );
}

const root = document.getElementById("launch-playground-root");
if (!root) throw new Error("Launch playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <LaunchPlayground />
  </StrictMode>,
);
