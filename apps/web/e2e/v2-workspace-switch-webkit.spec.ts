import { realTest } from "./real-omp";
import { defineWorkspaceSwitch } from "./v2-workspace-switch-checks";

/** Switching workspaces in WebKit, the desktop window's engine. */
realTest.use({ browserName: "webkit", channel: "" });
defineWorkspaceSwitch("webkit");
