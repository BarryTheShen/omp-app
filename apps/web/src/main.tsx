import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installClientErrorReporting } from "./app/client-errors";
import { AppErrorBoundary } from "./app/error-boundary";
import "./index.css";

// Before anything renders, so an error during start-up is reported too.
installClientErrorReporting();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The app root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
