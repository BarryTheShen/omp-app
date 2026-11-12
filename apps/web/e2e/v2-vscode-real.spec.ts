import { execFileSync, execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import { APP_ROOT, expect, realTest } from "./real-omp";

/**
 * The VS Code extension (`apps/vscode`) as a person gets it: packed into its `.vsix` with `vsce`, as the release packs
 * it, and installed into a real VS Code (`OMP_APP_VSCODE`, the folder of a VS Code for Linux, as the build server's test
 * image has it, with `vsce`). Its panel sits in the secondary side bar. The app always lets VS Code show it, so the panel
 * shows the app at once, pairs once with a one-time code, and the folder's chat reads a file, changes it once Accept is
 * clicked in VS Code's review, and runs a command once Run is clicked.
 */
const VSCODE = process.env.OMP_APP_VSCODE || null;
/** The command that packs an extension: `vsce`, or as `OMP_APP_VSCE` names it (`npx --yes @vscode/vsce@4.1.0`). */
const VSCE = process.env.OMP_APP_VSCE || "vsce";
const ready = /^(Fake Model|Message omp)/;
/** VS Code's window: wide enough for the editor and both side bars. */
const WINDOW = { width: 1600, height: 1000 };

/** Builds the extension and packs it as the release does; returns the `.vsix`. */
function packed(into: string): string {
  const extension = resolve(APP_ROOT, "apps/vscode");
  execFileSync("bun", ["run", "build"], { cwd: extension, stdio: "pipe" });
  const vsix = join(into, "omp-app-vscode.vsix");
  execSync(`${VSCE} package --no-dependencies --out "${vsix}"`, {
    cwd: extension,
    stdio: "pipe",
    input: "",
  });
  return vsix;
}

realTest.describe("new UI: the VS Code extension in a real VS Code", () => {
  realTest.skip(
    VSCODE === null,
    "needs VS Code and vsce (OMP_APP_VSCODE, as the build server's test image has them)",
  );
  realTest.setTimeout(420_000);

  realTest(
    "installed from its .vsix, it sits on the right, then pairs and works on the folder",
    async ({ realApp }, testInfo) => {
      const scratch = testInfo.outputPath("vscode");
      const project = join(scratch, "demo-project");
      const user = join(scratch, "user");
      const extensions = join(scratch, "extensions");
      await mkdir(project, { recursive: true });
      await mkdir(join(user, "User"), { recursive: true });
      await writeFile(join(project, "README.md"), "# Demo project\nline two\n");

      const owner = await realApp.open({ path: "/" });
      const app = new URL(owner.url()).origin;
      await writeFile(
        join(user, "User", "settings.json"),
        JSON.stringify({
          "ompApp.address": app,
          // VS Code's own dialogs and notifications, which the test can click (the system's cannot be reached).
          "window.dialogStyle": "custom",
          "workbench.startupEditor": "none",
          "update.mode": "none",
          "telemetry.telemetryLevel": "off",
        }),
      );
      const code = VSCODE ?? "";
      // VS Code keeps state in the home folder too (`~/.vscode/argv.json`, `~/.vscode-shared`), and makes its control socket
      // in XDG_RUNTIME_DIR, else in its profile folder, whose path in the test's results is past the 108 characters a
      // socket's path may have (the build server's containers set no XDG_RUNTIME_DIR). A short folder of the test's own
      // is both, so the test leaves nothing in the real home and the socket's path stays short.
      const own = await mkdtemp(join(tmpdir(), "vsc-"));
      // The system's opener, as VS Code calls it on Linux (`xdg-open`), stood in for: it keeps each address it is handed.
      const opened = join(own, "opened.txt");
      await mkdir(join(own, "bin"));
      await writeFile(
        join(own, "bin", "xdg-open"),
        `#!/bin/sh\nprintf '%s\\n' "$1" >> "${opened}"\n`,
        {
          mode: 0o755,
        },
      );
      const env = {
        ...process.env,
        HOME: own,
        XDG_RUNTIME_DIR: own,
        PATH: `${join(own, "bin")}:${process.env.PATH ?? ""}`,
      };
      execFileSync(
        join(code, "bin/code"),
        [
          "--install-extension",
          packed(scratch),
          "--extensions-dir",
          extensions,
          "--user-data-dir",
          user,
        ],
        { stdio: "pipe", env },
      );
      const vscode = await electron.launch({
        env,
        executablePath: join(code, "code"),
        args: [
          project,
          `--user-data-dir=${user}`,
          `--extensions-dir=${extensions}`,
          // No keyring on the test machine: VS Code keeps secrets, the panel's key among them, with its own encryption.
          "--password-store=basic",
          "--disable-workspace-trust",
          "--skip-welcome",
          "--skip-release-notes",
          "--disable-telemetry",
          "--disable-updates",
          "--ozone-platform=headless",
          "--disable-gpu",
          "--no-sandbox",
        ],
        timeout: 120_000,
      });
      try {
        const window = await vscode.firstWindow();
        await window.waitForSelector(".monaco-workbench", { timeout: 120_000 });
        await window.setViewportSize(WINDOW);
        await expect(window.locator(".part.activitybar")).toBeVisible();
        // Opened as the command palette opens it: "omp app: Focus on Chat View".
        await window.keyboard.press("F1");
        const palette = window.locator(".quick-input-widget input");
        await expect(palette).toBeVisible();
        await palette.fill(">omp app: Focus on Chat View");
        await expect(
          window
            .locator(".quick-input-list .monaco-list-row")
            .filter({ hasText: "Focus on Chat View" }),
        ).toHaveCount(1);
        await window.keyboard.press("Enter");

        // In the secondary side bar, the right one; nothing of it on the left. VS Code lays a panel's page over its
        // place, outside the side bar's own elements, so the page's box is what lies in the side bar.
        const right = window.locator(".part.auxiliarybar");
        const webview = window.locator("iframe.webview");
        await expect(webview).toBeVisible({ timeout: 60_000 });
        const rightBox = await right.boundingBox();
        const pageBox = await webview.boundingBox();
        if (rightBox === null || pageBox === null)
          throw new Error("No secondary side bar, or no panel.");
        expect(rightBox.x).toBeGreaterThan(WINDOW.width / 2);
        expect(pageBox.x).toBeGreaterThanOrEqual(rightBox.x - 1);
        expect(pageBox.x + pageBox.width).toBeLessThanOrEqual(rightBox.x + rightBox.width + 1);
        await expect(
          window.locator(".part.activitybar, .part.sidebar").locator('[aria-label^="omp app"]'),
        ).toHaveCount(0);
        const page = window.frameLocator("iframe.webview").first().frameLocator("#active-frame");

        // The app, which pairs once with a one-time code typed in the panel.
        const lite = page.frameLocator('iframe[title="omp app"]');
        await expect(lite.getByRole("heading", { name: "Pair this device" })).toBeVisible({
          timeout: 60_000,
        });
        // The one-time code comes from Settings → App → Devices on the app's own page.
        await owner.getByRole("button", { name: "Settings", exact: true }).click();
        const devices = owner.getByRole("region", { name: "Devices" });
        await devices.getByRole("button", { name: "Pair a new device" }).click();
        const shown = devices
          .getByRole("region", { name: "One-time code" })
          .getByText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
        await expect(shown).toBeVisible();
        await lite.getByRole("button", { name: "Enter a code instead" }).click();
        await lite.getByLabel("One-time code").fill((await shown.textContent()) ?? "");
        await lite.getByRole("button", { name: "Pair", exact: true }).click();
        const box = lite.getByRole("textbox", { name: "Message" });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
        await window.screenshot({ path: testInfo.outputPath("2-paired.png") });
        const send = async (text: string): Promise<void> => {
          await box.fill(text);
          await lite.getByRole("button", { name: "Send", exact: true }).click();
        };

        // The panel's chat has the extension's tools for the folder open in VS Code, beside omp's own for the server's.
        await send("tools_offered");
        const offered = lite.getByText(/^tools: /);
        await expect(offered).toBeVisible({ timeout: 60_000 });
        const names = ((await offered.textContent()) ?? "").replace(/^tools: /, "").split(", ");
        for (const name of ["vscode_read", "vscode_edit", "vscode_run", "vscode_search"])
          expect(names).toContain(name);
        for (const name of ["bash", "edit", "grep", "glob"]) expect(names).toContain(name);

        // It reads the file in VS Code's folder.
        await send('call_tool vscode_read {"path":"README.md"}');
        await expect(lite.getByText(/tool said: 1\s+# Demo project/)).toBeVisible({
          timeout: 60_000,
        });

        // A change waits for Accept in VS Code's review, then is made in the folder.
        await send(
          'call_tool vscode_edit {"path":"README.md","old_text":"line two","new_text":"line two, edited from omp app"}',
        );
        const accept = window
          .locator(".notifications-toasts")
          .getByRole("button", { name: "Accept" });
        await expect(accept).toBeVisible({ timeout: 60_000 });
        expect(await readFile(join(project, "README.md"), "utf8")).toBe(
          "# Demo project\nline two\n",
        );
        await window.screenshot({ path: testInfo.outputPath("3-review.png") });
        await accept.click();
        await expect(lite.getByText("tool said: Changed README.md.")).toBeVisible({
          timeout: 60_000,
        });
        expect(await readFile(join(project, "README.md"), "utf8")).toBe(
          "# Demo project\nline two, edited from omp app\n",
        );

        // A command waits for Run in VS Code's dialog, then runs in the folder.
        await send('call_tool vscode_run {"command":"echo ran-in-vscode"}');
        const run = window.locator(".monaco-dialog-box").getByRole("button", { name: "Run" });
        await expect(run).toBeVisible({ timeout: 60_000 });
        await run.click();
        const said = lite.getByText(/tool said: exit code 0/);
        await expect(said).toBeVisible({ timeout: 60_000 });
        await expect(said).toContainText("ran-in-vscode");
        await window.screenshot({ path: testInfo.outputPath("4-done.png") });

        // Copying: VS Code lets only its own webview pages write the clipboard, not the app's page framed in this one,
        // so the panel hands the text to the extension, which has VS Code put it in the clipboard.
        await send("stream_code");
        const block = lite.locator(".tr-code").last();
        await expect(block).toContainText("export const answer = sum([1, 2, 3]);", {
          timeout: 60_000,
        });
        const code = ((await block.locator("code").textContent()) ?? "").replace(/\n$/, "");
        expect(code.startsWith("export function sum(values: number[]): number {")).toBe(true);
        await vscode.evaluate(({ clipboard }) => clipboard.writeText("not copied yet"));
        const copy = block.getByRole("button", { name: "Copy code" });
        await copy.click();
        await expect(copy).toHaveText("Copied");
        await expect
          .poll(() => vscode.evaluate(({ clipboard }) => clipboard.readText()))
          .toBe(code);

        // The arrow and Open in the desktop app: VS Code's frames may open no window or other app's link, so the panel
        // asks the extension, and VS Code hands each to the system's opener; the panel stays on the chat.
        const handed = async (): Promise<string[]> =>
          (await readFile(opened, "utf8").catch(() => ""))
            .split("\n")
            .filter((line) => line !== "");
        const allow = async (): Promise<void> => {
          // VS Code may ask before it opens a link (its trusted domains): the test says yes.
          const ask = window
            .locator(".monaco-dialog-box")
            .getByRole("button", { name: "Open", exact: true });
          await ask.waitFor({ state: "visible", timeout: 3_000 }).then(
            () => ask.click(),
            () => undefined,
          );
        };
        await lite.getByRole("link", { name: "Open in the full app" }).click();
        await allow();
        await expect.poll(handed, { timeout: 30_000 }).toHaveLength(1);
        const full = new URL((await handed())[0] ?? "");
        expect(full.origin).toBe(app);
        expect(full.hash).toMatch(/^#chat=[0-9a-f-]+$/);
        await lite.getByRole("button", { name: "Where the full app opens" }).click();
        await lite.getByRole("menuitem", { name: "Open in the desktop app" }).click();
        await allow();
        await expect.poll(handed, { timeout: 30_000 }).toHaveLength(2);
        const desktop = new URL((await handed())[1] ?? "");
        expect(desktop.protocol).toBe("omp-app:");
        expect(`${desktop.host}${desktop.pathname}`).toBe(
          `chat/${full.hash.slice("#chat=".length)}`,
        );
        expect(desktop.searchParams.get("server")).toBe(app);
        await expect(box).toBeVisible();
        await window.screenshot({ path: testInfo.outputPath("4b-opened.png") });
        // The keys back to VS Code: the last click was in the panel's frame, which keeps them (F1 among them).
        await window.locator(".part.editor").click();

        // A page that answers late (a slow network, a relay): after 10 s the panel says why it has not opened, over
        // the frame, which keeps loading; when the page answers, the chat takes its place back without a click.
        let delayed = 0;
        const litePage = (url: URL): boolean =>
          url.origin === app && url.pathname.startsWith("/lite");
        await vscode.context().route(litePage, async (route) => {
          if (route.request().resourceType() === "document") {
            delayed += 1;
            await new Promise((done) => setTimeout(done, 14_000));
          }
          await route.continue();
        });
        await window.keyboard.press("F1");
        await palette.fill(">Developer: Reload Webviews");
        await expect(
          window
            .locator(".quick-input-list .monaco-list-row")
            .filter({ hasText: "Reload Webviews" }),
        ).toHaveCount(1);
        await window.keyboard.press("Enter");
        const late = page.getByText(
          `omp app at ${app} answers, but its page didn't open in this panel.`,
        );
        await expect(late).toBeVisible({ timeout: 30_000 });
        expect(delayed).toBeGreaterThan(0);
        await window.screenshot({ path: testInfo.outputPath("5-late-note.png") });
        await expect(late).toBeHidden({ timeout: 30_000 });
        await expect(box).toHaveAttribute("placeholder", ready, { timeout: 30_000 });
        await expect(box).toBeVisible();
        await window.screenshot({ path: testInfo.outputPath("6-late-answered.png") });
      } finally {
        await vscode.close().catch(() => undefined);
        await rm(own, { recursive: true, force: true });
      }
    },
  );
});
