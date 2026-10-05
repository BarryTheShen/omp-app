import { createRoot } from "react-dom/client";
import { ContextUsagePlayground } from "./playground";

const root = document.getElementById("p7-context-playground-root");
if (!root) throw new Error("P7 context playground root is missing.");

createRoot(root).render(<ContextUsagePlayground />);
