import { realTest } from "./real-omp";
import { definePdfChecks } from "./v2-pdf-checks";

/** A PDF in the Files panel in WebKit, the desktop window's engine and the iPhone's. */
realTest.use({ browserName: "webkit", channel: "" });
definePdfChecks("webkit");
