import { createRoot } from "react-dom/client";
import { D7ModesPlayground } from "./playground";

const root = document.getElementById("d7-3-modes-playground-root");
if (!root) throw new Error("D7.3 modes playground root is missing.");

createRoot(root).render(<D7ModesPlayground />);
