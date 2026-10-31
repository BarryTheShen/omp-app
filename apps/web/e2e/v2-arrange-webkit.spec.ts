import { realTest } from "./real-omp";
import { defineArrangeChecks } from "./v2-arrange-checks";

/** Arranging the new UI's windows in WebKit, the desktop window's engine. */
realTest.use({ browserName: "webkit", channel: "" });
defineArrangeChecks("webkit");
