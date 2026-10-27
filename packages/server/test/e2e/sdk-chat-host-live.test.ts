/**
 * Live voice on the chat host (SDK plan H5.2g4), end to end on omp's own controller. The test's omp has no ChatGPT
 * sign-in, so a live start fails while it connects, before any microphone is opened; that path runs omp's controller,
 * its events and the slot's release. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("live voice on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: without a ChatGPT sign-in a live start connects, fails and ends, and the slot is free again`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await expect(chat.client.request("live_mute", {})).rejects.toMatchObject({
          code: "failed",
          message: "No live session is active",
        });
        expect(await chat.client.request("live_stop", {})).toEqual({});

        const failure = await chat.client.request("live_start", {}).then(
          () => undefined,
          (error: unknown) => error as { code?: string; message?: string },
        );
        expect(failure?.code).toBe("failed");
        expect(await chat.next((event) => event.type === "live_phase")).toMatchObject({
          phase: "connecting",
        });
        const end = await chat.next((event) => event.type === "live_end");
        expect(end).toMatchObject({ type: "live_end", error: failure?.message });

        // The failed session is gone: a new start fails the same way instead of finding one still active.
        await expect(chat.client.request("live_start", {})).rejects.toMatchObject({
          message: failure?.message,
        });
        await expect(chat.client.request("live_mute", { muted: true })).rejects.toMatchObject({
          message: "No live session is active",
        });
      },
      60_000,
    );
  }
});
