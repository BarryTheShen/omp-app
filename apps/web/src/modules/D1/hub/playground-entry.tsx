import { createRoot } from "react-dom/client";
import { ModelHubPlayground } from "./playground";

const root = document.getElementById("d1-model-hub-playground-root");
if (!root) throw new Error("D1 model hub playground root is missing.");

createRoot(root).render(<ModelHubPlayground />);
