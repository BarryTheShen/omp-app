import { type CapabilityMap, type RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { optIntoRichAsk, richAskOffered } from "./rich-ask";

const threadId = ThreadId.parse("thread-rich-ask");

describe("rich ask questions", () => {
  test("are offered only when omp has both the dialog capability and the opt-in command", () => {
    const both: CapabilityMap = {
      "omp.ui": { state: "available", via: "rpc" },
      "omp.cmd.set_ask_dialog": { state: "available", via: "rpc" },
    };
    expect(richAskOffered(both)).toBe(true);
    expect(richAskOffered({ "omp.ui": { state: "available", via: "rpc" } })).toBe(false);
    expect(
      richAskOffered({
        ...both,
        "omp.cmd.set_ask_dialog": { state: "unavailable", via: "rpc" },
      }),
    ).toBe(false);
  });

  test("opts the session in with one set_ask_dialog command", async () => {
    const sent: unknown[] = [];
    const send: RpcSessionSend = async (args) => {
      sent.push(args);
      return { enabled: true } as never;
    };
    await optIntoRichAsk(send, threadId);
    expect(sent).toEqual([{ threadId, command: { type: "set_ask_dialog", enabled: true } }]);
  });

  test("fails with a typed error when omp does not confirm the opt-in", async () => {
    const send: RpcSessionSend = async () => ({ enabled: false }) as never;
    await expect(optIntoRichAsk(send, threadId)).rejects.toMatchObject({
      appError: { code: "omp_error" },
    });
  });
});
