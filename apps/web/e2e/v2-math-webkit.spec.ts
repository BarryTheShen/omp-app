import { realTest } from "./real-omp";
import { defineMathChecks } from "./v2-math-checks";

// The desktop window's engine, and Safari's.
realTest.use({ browserName: "webkit", channel: "" });
defineMathChecks("webkit");
