import { createRoot } from "react-dom/client";
import { CommandPlayground } from "./playground";

const root = document.getElementById("p7-command-playground-root");
if (!root) throw new Error("The command preview is missing its root element.");
createRoot(root).render(<CommandPlayground />);
