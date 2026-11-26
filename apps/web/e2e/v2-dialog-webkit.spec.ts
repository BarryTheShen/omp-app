import { realTest } from "./real-omp";
import { defineDialogChecks } from "./v2-dialog-checks";

/** The app's dialogs drawn sharp, in WebKit, the desktop window's engine. */
realTest.use({ browserName: "webkit", channel: "" });
defineDialogChecks("webkit");
