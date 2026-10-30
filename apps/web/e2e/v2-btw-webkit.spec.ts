import { realTest } from "./real-omp";
import { defineBtwChecks } from "./v2-btw-checks";

/** omp's `/btw` in the new UI in WebKit, the desktop window's engine. */
realTest.use({ browserName: "webkit", channel: "" });
defineBtwChecks("webkit");
