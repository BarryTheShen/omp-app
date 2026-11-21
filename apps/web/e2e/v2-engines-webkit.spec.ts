import { realTest } from "./real-omp";
import { defineEngineChecks } from "./v2-engines-checks";

/** The app in WebKit: Safari's engine, and the Linux desktop window's. */
realTest.use({ browserName: "webkit", channel: "" });
defineEngineChecks("webkit");
