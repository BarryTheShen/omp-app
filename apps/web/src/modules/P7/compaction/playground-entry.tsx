import { createRoot } from "react-dom/client";
import { CompactionPlayground } from "./playground";

const root = document.getElementById("p7-compaction-playground-root");
if (!root) throw new Error("The compaction preview is missing its root element.");
createRoot(root).render(<CompactionPlayground />);
