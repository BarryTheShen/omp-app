import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

/** What a person is told when a chat is open in another tab or window (the server's answer, plain words). */
const OPEN_ELSEWHERE = "This chat is open in another tab or window.";

/**
 * Issue #762. A second tab on the same folder either attaches to the chat the first tab holds or says in plain words
 * that the chat is open elsewhere; it never shows a raw server error. The second tab is opened from the first with
 * `window.open`, so both share the browser profile and the second tab reads the saved chat and attaches to it. The app
 * never asks the server for the newest chat (`start: "latest"`), so a second connection that does is made here by
 * hand: the server refuses it, and the refusal must be the plain words.
 */
realTest(
  "a second tab attaches to the open chat, and a second connection asking for the newest chat is told in plain words",
  async ({ realApp }) => {
    const first = await realApp.open();
    const composer = await startChat(first);
    await sendPrompt(composer, "ping");
    await expect(first.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const launch = `${new URL(first.url()).origin}/#token=${encodeURIComponent(realApp.token)}`;
    const popup = first.waitForEvent("popup");
    await first.evaluate((url) => {
      window.open(url, "_blank");
    }, launch);
    const second = await popup;
    const secondProblems: string[] = [];
    second.on("console", (message) => {
      if (message.type() === "error") secondProblems.push(`console error: ${message.text()}`);
    });
    second.on("pageerror", (error) => secondProblems.push(`page error: ${error.message}`));

    // The second tab opens straight into the saved chat: the first tab's answer and a composer are on its screen.
    await expect(second.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(second.getByRole("textbox", { name: "Message input" })).toBeVisible();
    await expect(second.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);

    // A second connection on the second tab asks the server for the folder's newest chat, as a raw client would.
    const answer = await second.evaluate(
      ({ token, folder }) =>
        new Promise<{ ok: boolean; error?: { code: string; message: string } }>(
          (resolve, reject) => {
            const scheme = location.protocol === "https:" ? "wss" : "ws";
            const socket = new WebSocket(
              `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`,
            );
            socket.addEventListener("open", () => {
              socket.send(
                JSON.stringify({
                  type: "hello",
                  protocols: ["omp-app/1"],
                  client: { name: "two-tabs-e2e", version: "1.0.0" },
                }),
              );
            });
            socket.addEventListener("message", (event) => {
              const frame = JSON.parse(String(event.data));
              if (frame.type === "welcome") {
                socket.send(
                  JSON.stringify({
                    type: "call",
                    id: "newest",
                    port: "A0.rpcSession",
                    method: "open",
                    args: { folderPath: folder, start: "latest" },
                  }),
                );
                return;
              }
              if (frame.type === "result" && frame.id === "newest") {
                socket.close();
                resolve({ ok: frame.ok === true, error: frame.error });
              }
            });
            socket.addEventListener("error", () =>
              reject(new Error("the second connection failed")),
            );
          },
        ),
      { token: realApp.token, folder: realApp.folder },
    );
    expect(answer).toMatchObject({
      ok: false,
      error: { code: "conflict", message: OPEN_ELSEWHERE },
    });

    // The first tab keeps its chat, and neither tab shows a problem.
    await expect(first.getByText("pong", { exact: true })).toBeVisible();
    expect(realApp.problems).toEqual([]);
    expect(secondProblems).toEqual([]);
  },
);
