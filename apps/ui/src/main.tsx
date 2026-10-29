import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./vendor/collab-web/styles/tokens.css";
import "./app.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("The page has no #root element.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
