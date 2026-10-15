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
});
