import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "katex/dist/katex.min.css";
import "./styles/index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App";
import { isLiteView, liteThemeMode } from "./lite/lite";
import { startLiteTheme, startTheme } from "./theme/theme";
import { followVisualViewport } from "./viewport";

if (isLiteView()) startLiteTheme(liteThemeMode());
else startTheme();
followVisualViewport();
const root = document.getElementById("root");
if (root === null) throw new Error("The page has no #root element.");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider delay={500}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
