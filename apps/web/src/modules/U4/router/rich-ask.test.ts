import { type CapabilityMap, type ChatSessionRequest, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { optIntoRichAsk, richAskOffered } from "./rich-ask";

const threadId = ThreadId.parse("thread-rich-ask");

describe("rich ask questions", () => {
  test("are offered only when omp has both the dialog capability and the opt-in command", () => {
    const both: CapabilityMap = {
      "omp.ui": { state: "available", via: "omp" },
      "omp.cmd.set_ask_dialog": { state: "available", via: "omp" },
    };
    expect(richAskOffered(both)).toBe(true);
    expect(richAskOffered({ "omp.ui": { state: "available", via: "omp" } })).toBe(false);
    expect(
      richAskOffered({
        ...both,
        "omp.cmd.set_ask_dialog": { state: "unavailable", via: "omp" },
      }),
    ).toBe(false);
  });

  test("opts the session in with one set_ask_dialog request", async () => {
    const sent: unknown[] = [];
    const request: ChatSessionRequest = async (args) => {
      sent.push(args);
      return { enabled: true } as never;
    };
    await optIntoRichAsk(request, threadId);
    expect(sent).toEqual([{ threadId, method: "set_ask_dialog", params: { enabled: true } }]);
  });

  test("fails with a typed error when omp does not confirm the opt-in", async () => {
    const send: ChatSessionRequest = async () => ({ enabled: false }) as never;
    await expect(optIntoRichAsk(send, threadId)).rejects.toMatchObject({
      appError: { code: "omp_error" },
    });
  });
});
