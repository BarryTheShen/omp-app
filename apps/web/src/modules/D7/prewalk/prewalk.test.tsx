import { AppFailure, type CommandRunResult, type ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { D74CommandClient } from "./commands";
import { runD74Command, unknownAfterReconnect } from "./commands";
import { PrewalkSurface } from "./index";

afterEach(() => cleanup());

const threadId = "thread-d74" as ThreadId;
const completed: CommandRunResult = {
  command: "/prewalk",
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [{ text: "Prewalk armed for the next edit." }],
  sessionUpdates: [],
  configUpdates: [],
};

describe("D7.4 preparation and context", () => {
  test("forwards a typed command and preserves omp output verbatim", async () => {
    const commands: string[] = [];
    const client: D74CommandClient = {
      run: async (_thread: ThreadId, command) => {
        commands.push(command);
        return completed;
      },
    };
    const result = await runD74Command(client, threadId, "/shake images");
    expect(commands).toEqual(["/shake images"]);
    expect(result.state).toBe("complete");
    expect(result.result?.outputs[0]?.text).toBe("Prewalk armed for the next edit.");
  });

  test("rejects model invocation and reports aborted typed results", async () => {
    const invoked = await runD74Command(
      { run: async () => ({ ...completed, agentInvoked: true }) },
      threadId,
      "/prewalk",
    );
    expect(invoked.state).toBe("error");
    expect(invoked.message).toBe("omp did not recognise this command.");

    const aborted = await runD74Command(
      { run: async () => ({ ...completed, status: "aborted" }) },
      threadId,
      "/prewalk",
    );
    expect(aborted.message).toBe("omp stopped before it finished this command.");
  });

  test("keeps typed failure wording and hides untyped error details", async () => {
    const typedClient: D74CommandClient = {
      run: async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "Command unavailable in this chat.",
          retryable: false,
        });
      },
    };
    const typed = await runD74Command(typedClient, threadId, "/prewalk");
    expect(typed.message).toBe("Command unavailable in this chat.");

    const unknownClient: D74CommandClient = {
      run: async () => {
        throw new Error("/home/private/config.yml");
      },
    };
    const unknown = await runD74Command(unknownClient, threadId, "/prewalk");
    expect(unknown.message).toBe("The app could not reach omp. Try again.");
  });

  test("uses accurate action labels and visibly handles reconnect uncertainty", () => {
    const onRun = vi.fn();
    render(
      <PrewalkSurface
        canRun
        onRetry={vi.fn()}
        onRun={onRun}
        surface={unknownAfterReconnect("/prewalk")}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("reconnected");
    fireEvent.click(screen.getByRole("button", { name: "Cancel the model switch" }));
    expect(onRun).toHaveBeenCalledWith("/prewalk off");
  });

  test("disables actions when the command gateway is unavailable", () => {
    render(
      <PrewalkSurface
        canRun={false}
        onRetry={vi.fn()}
        onRun={vi.fn()}
        surface={{ state: "unavailable", message: "Commands are not available in this chat." }}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Switch model at the next edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Commands are not available in this chat.")).toBeTruthy();
  });
});
