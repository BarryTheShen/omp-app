import { realTest } from "./real-omp";
import { defineModelHubChecks } from "./v2-model-hub-checks";

/** omp's model hub (Alt+M) in the new UI in WebKit, the desktop window's engine. */
realTest.use({ browserName: "webkit", channel: "" });
defineModelHubChecks("webkit");
