import { createRoot } from "react-dom/client";
import { SettingsKitPlayground } from "./playground";

const root = document.getElementById("settings-kit-playground-root");
if (!root) throw new Error("S1 settings playground root is missing.");

createRoot(root).render(<SettingsKitPlayground />);
