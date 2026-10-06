import { createRoot } from "react-dom/client";
import { S2SectionsPlayground } from "./playground";

const root = document.getElementById("s2-sections-playground-root");
if (!root) throw new Error("S2 settings playground root is missing.");

createRoot(root).render(<S2SectionsPlayground />);
