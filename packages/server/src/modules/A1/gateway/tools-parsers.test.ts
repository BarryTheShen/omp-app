import { describe, expect, test } from "bun:test";
import { AppFailure } from "@omp-app/contracts";
import type { CommandParserContext } from "./gateway";
import { parseToolsReply } from "./tools-parsers";

function reply(texts: readonly string[], agentInvoked = false): CommandParserContext {
  return {
    command: "/tools",
    agentInvoked,
    outputs: texts.map((text) => ({ text })),
    sessionUpdates: [],
    configUpdates: [],
  };
}

describe("/tools typed availability parser", () => {
  test("maps omp's recorded prefixes and merges xd:// aliases by tool name", () => {
    expect(
      parseToolsReply(
        reply([
          "* read\n* bash\n* edit\n- ast_edit\n* ask\n- debug\n* eval\n* glob\n* grep\n- lsp\n* task\n* wait\n* todo\n* web_search\n* write\n- goal\n- init_experiment\n- run_experiment\n- log_experiment\n- update_notes\n~ xd://ast_edit\n~ xd://debug\n~ xd://lsp",
        ]),
      ),
    ).toEqual({
      tools: [
        { tool: "read", state: "available" },
        { tool: "bash", state: "available" },
        { tool: "edit", state: "available" },
        { tool: "ast_edit", state: "fallback" },
        { tool: "ask", state: "available" },
        { tool: "debug", state: "fallback" },
        { tool: "eval", state: "available" },
        { tool: "glob", state: "available" },
        { tool: "grep", state: "available" },
        { tool: "lsp", state: "fallback" },
        { tool: "task", state: "available" },
        { tool: "wait", state: "available" },
        { tool: "todo", state: "available" },
        { tool: "web_search", state: "available" },
        { tool: "write", state: "available" },
        { tool: "goal", state: "unavailable" },
        { tool: "init_experiment", state: "unavailable" },
        { tool: "run_experiment", state: "unavailable" },
        { tool: "log_experiment", state: "unavailable" },
        { tool: "update_notes", state: "unavailable" },
      ],
    });
  });

  test("accepts omp's explicit no-tools reply", () => {
    expect(parseToolsReply(reply(["No tools are available."]))).toEqual({ tools: [] });
  });

  test("rejects a reply with no text instead of reporting an empty tool list", () => {
    expect(() => parseToolsReply(reply([]))).toThrow(AppFailure);
    expect(() => parseToolsReply(reply(["  \n"]))).toThrow(AppFailure);
  });

  test("keeps an active tool available when it is also mounted on the xd:// device", () => {
    expect(parseToolsReply(reply(["* read\n- ast_edit\n~ xd://read\n~ xd://ast_edit"]))).toEqual({
      tools: [
        { tool: "read", state: "available" },
        { tool: "ast_edit", state: "fallback" },
      ],
    });
  });

  test("rejects malformed lines and model-invoked commands", () => {
    expect(() => parseToolsReply(reply(["? unknown"]))).toThrow(AppFailure);
    expect(() => parseToolsReply(reply(["* bash"], true))).toThrow(AppFailure);
  });

  test("does not accept a reply for another command", () => {
    expect(() => parseToolsReply({ ...reply(["* bash"]), command: "/skillful status" })).toThrow(
      AppFailure,
    );
  });
});
