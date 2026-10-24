import { describe, expect, test } from "vitest";
import { openNewChatTicket } from "./new-chat-outcome";

describe("a New chat's outcome", () => {
  test("a New chat whose chat opens settles opened", async () => {
    const ticket = openNewChatTicket();
    ticket.settle("opened");
    await expect(ticket.outcome).resolves.toBe("opened");
  });

  test("a New chat that ends without opening settles not-opened", async () => {
    const ticket = openNewChatTicket();
    ticket.settle("not-opened");
    await expect(ticket.outcome).resolves.toBe("not-opened");
  });

  test("the first settle wins: a later one does not change the outcome", async () => {
    const ticket = openNewChatTicket();
    ticket.settle("not-opened");
    ticket.settle("opened");
    await expect(ticket.outcome).resolves.toBe("not-opened");
  });

  test("waits for the chat view to finish opening after the send settles", async () => {
    const ticket = openNewChatTicket();
    const open = Promise.withResolvers<void>();
    const send = Promise.withResolvers<void>();
    ticket.trackOpen(open.promise);
    ticket.trackSend(send.promise);
    ticket.settle("opened");
    const waiting = ticket.waitForSettled();
    let finished = false;
    void waiting.then(() => {
      finished = true;
    });
    send.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    open.resolve();
    await expect(waiting).resolves.toBe(true);
  });

  test("a failed open blocks a later New chat", async () => {
    const ticket = openNewChatTicket();
    const open = Promise.withResolvers<void>();
    ticket.trackOpen(open.promise);
    ticket.trackSend(Promise.resolve());
    ticket.settle("opened");
    const waiting = ticket.waitForSettled();
    open.reject(new Error("chat view failed"));
    await expect(waiting).resolves.toBe(false);
  });

  test("a failed first draft submission blocks a later New chat", async () => {
    const ticket = openNewChatTicket();
    ticket.trackOpen(Promise.resolve());
    const send = Promise.withResolvers<void>();
    ticket.trackSend(send.promise);
    ticket.settle("opened");
    const waiting = ticket.waitForSettled();
    send.reject(new Error("send refused"));
    await expect(waiting).resolves.toBe(false);
  });
});
