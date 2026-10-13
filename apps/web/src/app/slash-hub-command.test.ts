import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { AgentHubOpenResult } from "./agents/agent-hub-shortcut";
import { agentHubSlashCommand } from "./slash-commands";

describe("#1257 /hub", () => {
  test("is named hub and described in plain words", () => {
    const command = agentHubSlashCommand({ openAgentHub: async () => "opened" });
    expect(command.name).toBe("hub");
    expect(command.description).toBe("Open the Agent Hub");
  });

  test("an Agent Hub that opens finishes without a message, after one open", async () => {
    const openAgentHub = vi.fn(async (): Promise<AgentHubOpenResult> => "opened");
    await expect(agentHubSlashCommand({ openAgentHub }).run({})).resolves.toEqual({});
    expect(openAgentHub).toHaveBeenCalledTimes(1);
  });

  test("a chat with no agent says there is nothing to show yet", async () => {
    const command = agentHubSlashCommand({ openAgentHub: async () => "empty" });
    await expect(command.run({})).resolves.toEqual({ message: "No agents to show yet." });
  });

  test("a chat that cannot start its agents fails with a reason the composer shows", async () => {
    const command = agentHubSlashCommand({ openAgentHub: async () => "unavailable" });
    await expect(command.run({})).rejects.toBeInstanceOf(AppFailure);
    await expect(command.run({})).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "The Agent Hub cannot open for this chat right now.",
        retryable: true,
      },
    });
  });
});
