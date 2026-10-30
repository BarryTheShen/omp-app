import { realTest } from "./real-omp";
import { defineScrollChecks } from "./v2-scroll-checks";

/** The new UI's transcript scrolling in WebKit, the desktop window's engine. */
realTest.use({ browserName: "webkit", channel: "" });
defineScrollChecks("webkit");
