import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { N1FeedbackPlayground } from "./playground";

const container = document.getElementById("n1-3-feedback-playground-root");
if (container === null) throw new Error("The notification playground has no mount point.");
createRoot(container).render(
  <StrictMode>
    <N1FeedbackPlayground />
  </StrictMode>,
);
