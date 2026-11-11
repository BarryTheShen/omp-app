import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "katex/dist/katex.min.css";
import "./styles/index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App";
import { writeClipboard } from "./clipboard";
import { embed } from "./lite/embed";
import { applyHostLook, BROWSER_CHECKS, hostLook } from "./lite/hostLook";
import { isLiteView, liteThemeMode } from "./lite/lite";
import { installPageErrorReporting } from "./pageErrors";
import { startLiteTheme, startTheme } from "./theme/theme";
import { CodeCopyContext } from "./vendor/collab-web/components/transcript/Markdown";
import { followVisualViewport } from "./viewport";

// From here on the page's errors go to the app's debug log; those before the connection wait for it (`App`).
installPageErrorReporting();

if (isLiteView()) {
  startLiteTheme(liteThemeMode());
  // The framing app's own colours, font and text size, over the theme (#2844).
  applyHostLook(hostLook(window.location.search, BROWSER_CHECKS));
  // The page that frames it talks to it from the first moment (`lite/embed.ts`): its hello may bring the panel's key.
  embed?.start();
} else startTheme();
followVisualViewport();
const root = document.getElementById("root");
if (root === null) throw new Error("The page has no #root element.");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider delay={500}>
      {/* A code block's Copy goes through the panel's host where the browser's clipboard refuses the page (VS Code). */}
      <CodeCopyContext value={writeClipboard}>
        <App />
      </CodeCopyContext>
    </TooltipProvider>
  </StrictMode>,
);
