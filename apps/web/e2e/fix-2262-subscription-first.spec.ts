import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/** The notice a finished worker's line goes in: the one that names the worker and how it ended. */
const NOTICE = '[data-slot="u1-custom-note"]';

/**
 * Issue 2262. omp reports a worker's end only to a chat whose worker stream is on when the worker ends. The stream used
 * to be requested when a card first asked for the chat's workers, after the prompt that spawns them; in a failing trace
 * that came 0.8 s after the prompt, and the stream was not on when the worker ended, so the app never received the end and
 * the notice read "was stopped". The stream is now requested before the chat's first prompt goes out. This test records
 * the order of the two requests on the wire and requires the worker to read as finished.
 */
realTest(
  "a chat requests its worker stream before its first prompt, so a worker that ends within seconds of its spawn reads as finished",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const order: string[] = [];
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.routeWebSocket(/.*/, (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((message) => {
            const text = String(message);
            if (text.includes('"method":"setSubagentSubscription"')) order.push("subscription");
            if (text.includes('"command":{"type":"prompt"')) order.push("prompt");
            server.send(message);
          });
          server.onMessage((message) => ws.send(message));
        });
      },
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_quiet_subagent");
    await expect(
      page.locator(NOTICE).filter({ hasText: "QuietProbe finished." }).first(),
    ).toBeVisible({
      timeout: 90_000,
    });
    expect(order, "the worker stream and the prompt were both requested").toEqual(
      expect.arrayContaining(["subscription", "prompt"]),
    );
    expect(
      order.indexOf("subscription"),
      "the worker stream is requested before the prompt that spawns a worker",
    ).toBeLessThan(order.indexOf("prompt"));
  },
);
