import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppConnectionProvider } from "@/launch/app-connection";
import { ContextSettingsPlayground } from "./playground";

const root = document.getElementById("p7-context-settings-playground-root");
if (!root) throw new Error("The context settings preview is missing its root element.");
createRoot(root).render(
  <StrictMode>
    <AppConnectionProvider>
      <ContextSettingsPlayground />
    </AppConnectionProvider>
  </StrictMode>,
);
