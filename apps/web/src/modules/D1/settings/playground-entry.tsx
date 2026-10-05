import { createRoot } from "react-dom/client";
import { ModelSettingsPlayground } from "./playground";

const root = document.getElementById("d1-model-settings-playground-root");
if (!root) throw new Error("D1 model settings playground root is missing.");

createRoot(root).render(<ModelSettingsPlayground />);
