import { realTest } from "./real-omp";
import { defineModelHubChecks } from "./v2-model-hub-checks";

/**
 * omp's model hub (Alt+M) in the new UI in WebKit, the desktop window's engine. With reduced motion: Playwright's
 * headless WebKit crashes its page on a popover's opening fade now and then (1 test in 15 a run), which the desktop
 * window's WebKitGTK never does (checked 2026-10-31); this spec checks the hub, not its motion.
 */
realTest.use({ browserName: "webkit", channel: "", reducedMotion: "reduce" });
defineModelHubChecks("webkit");
