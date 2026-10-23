import { describe, expect, test } from "vitest";
import { openNewChatTicket, reusesOpeningNewChat } from "./new-chat-outcome";

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
});

describe("a New chat click that comes while the New chat before it is opening", () => {
  test("with no message sent to the opening New chat, the click reuses its start", () => {
    expect(reusesOpeningNewChat({ ended: false, sent: false, shown: true })).toBe(true);
  });

  test("after a message was sent to the opening New chat, the click starts another New chat (#2343)", () => {
    expect(reusesOpeningNewChat({ ended: false, sent: true, shown: true })).toBe(false);
  });

  test("once the New chat before it has opened, the click starts another one", () => {
    expect(reusesOpeningNewChat({ ended: true, sent: false, shown: true })).toBe(false);
  });

  test("once a chat picked since its click has replaced the New chat on screen, the click starts one", () => {
    expect(reusesOpeningNewChat({ ended: false, sent: false, shown: false })).toBe(false);
  });

  test("with no New chat before it, the click starts one", () => {
    expect(reusesOpeningNewChat(undefined)).toBe(false);
  });
});
