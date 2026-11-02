import { describe, expect, test } from "bun:test";
import { SignIn, SignInCancelled, type SignInDialogs } from "./sign-in";

/**
 * Dialogs whose questions wait until their signal aborts, as the host's do when omp ends one, and then answer nothing;
 * a signal aborted already opens none, as the host's (`ui-context.ts`).
 */
const waitingDialogs: SignInDialogs = {
  input: (_title, _placeholder, options) =>
    new Promise((resolve) => {
      if (options?.signal?.aborted === true) resolve(undefined);
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
};

describe("a sign-in's questions", () => {
  test("a question omp ends itself (its own browser answered first) answers nothing and leaves the sign-in running", async () => {
    const signIn = new SignIn(waitingDialogs, "Test");
    const omp = new AbortController();
    const asked = signIn.ask("Paste the address", undefined, omp.signal);
    omp.abort();
    expect(await asked).toBe("");
    expect(signIn.cancelled).toBe(false);
  });

  test("a stop ends an open question and the sign-in's run, and a later question is not asked", async () => {
    const signIn = new SignIn(waitingDialogs, "Test");
    const asked = signIn.ask("Paste the address");
    const run = signIn.run(new Promise(() => {}));
    signIn.cancel();
    await expect(asked).rejects.toBeInstanceOf(SignInCancelled);
    expect(await run).toEqual({ cancelled: true });
    await expect(signIn.ask("Again")).rejects.toBeInstanceOf(SignInCancelled);
  });
});
