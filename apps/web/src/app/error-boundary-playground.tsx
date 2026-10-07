import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./error-boundary";

/** Always fails while rendering, to show what the person sees when the page breaks. */
function Broken(): never {
  throw new Error("usage.percent: Too big: expected number to be <=100");
}

const root = document.getElementById("error-boundary-playground-root");
if (!root) throw new Error("The error boundary playground root is missing.");

createRoot(root).render(
  <AppErrorBoundary>
    <Broken />
  </AppErrorBoundary>,
);
