import { dirname } from "node:path";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";
import { expectShareQuestion, pointOmpAtStub, sendTyped, startShareStub } from "./share-stub";

/** Every form of /share the composer can send. */
const FORMS = ["/share", "/share now", "  /SHARE", "/share:now"];

realTest(
  "#957: every form of /share asks first, nothing is uploaded when the person denies, and a plain prompt still reaches omp",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    // Plain HTTP: an upload attempt reaches the stub's requests even though no link could be shown.
    const stub = await startShareStub({ tls: false });
    try {
      await pointOmpAtStub(dirname(realApp.mcpConfigPath), stub.url);
      const page = await realApp.open();
      const composer = await startChat(page);
      for (const form of FORMS) {
        await sendTyped(page, composer, form);
        // The question is modal, so each form is answered before the next is sent.
        await expectShareQuestion(page, stub.url);
        expect(stub.requests).toEqual([]);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(page.getByText("Nothing was shared.", { exact: true })).toBeVisible();
        await expect(composer).toHaveValue("");
      }
      await sendPrompt(composer, "ping");
      await expect(page.getByText("pong", { exact: true })).toBeVisible();
      expect(stub.requests).toEqual([]);
      expect(realApp.problems).toEqual([]);
    } finally {
      await stub.close();
    }
  },
);
