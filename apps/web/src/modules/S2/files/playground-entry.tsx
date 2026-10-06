import { createRoot } from "react-dom/client";
import { FilesPlayground } from "./playground";

const root = document.getElementById("s2-files-playground-root");
if (!root) throw new Error("S2 Files playground root is missing.");

createRoot(root).render(<FilesPlayground />);
