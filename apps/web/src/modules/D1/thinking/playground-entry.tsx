import { createRoot } from "react-dom/client";
import { ThinkingPlayground } from "./playground";

const root = document.getElementById("d1-thinking-playground-root");
if (!root) throw new Error("D1 thinking playground root is missing.");

createRoot(root).render(<ThinkingPlayground />);
