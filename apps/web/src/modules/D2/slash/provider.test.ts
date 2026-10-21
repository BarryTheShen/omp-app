import { AppFailure, type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { createSlashCommandCatalog } from "./catalog";
import { createSlashCommandProvider } from "./provider";
import type { SlashAppCommand } from "./routing";
import { completedRun, fakeSlashClient, REAL_COMMAND_LIST } from "./test-support";

const threadId = ThreadId.parse("thread-d23-provider");
const available: CapabilityMap = {
  "omp.cmd.get_available_commands": { state: "available", via: "rpc" },
};
const newChat: SlashAppCommand = {
  name: "new",
  description: "Start a new chat",
  run: async () => ({ message: "Started a new chat." }),
};

describe("D2.3 slash provider", () => {
  test("a submit waits for the first read, so a known command routes before the list has loaded", async () => {
    const fake = fakeSlashClient();
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });

    expect(provider.catalog.getSnapshot().state).toBe("idle");
    await expect(provider.route("/usage")).resolves.toEqual({ kind: "omp", command: "/usage" });
    expect(fake.sent).toEqual(["get_available_commands"]);
    provider.dispose();
  });

  test("the app's commands are read at each route, so a new handler applies without a new provider", async () => {
    const fake = fakeSlashClient();
    let apps: readonly SlashAppCommand[] = [];
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
      appCommands: () => apps,
    });

    await expect(provider.route("/new")).resolves.toBeNull();
    apps = [newChat];
    await expect(provider.route("/new")).resolves.toEqual({ kind: "app", command: newChat });
    provider.dispose();
  });

  test("a guarded form stays out of the `/` list, which keeps omp's own commands, and still routes when typed", async () => {
    const fake = fakeSlashClient();
    const guarded: SlashAppCommand = {
      name: "usage reset",
      description: "Spend a saved rate-limit reset, after you confirm",
      takesArguments: true,
      unlisted: true,
      run: async () => ({}),
    };
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
      appCommands: () => [guarded],
    });

    const listed = (await provider.search("usage")).map((entry) => entry.label);
    expect(listed).toContain("/usage");
    expect(listed).not.toContain("/usage reset");
    await expect(provider.route("/usage reset codex/active")).resolves.toEqual({
      kind: "app",
      command: guarded,
      args: "codex/active",
    });
    provider.dispose();
  });

  test("execute runs a slash command through the gateway, and refuses text that is not one before any run", async () => {
    const fake = fakeSlashClient({
      run: async (command) => completedRun(command, "Usage: 0 tokens"),
    });
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });

    const result = await provider.execute("/usage");
    expect(fake.runs).toEqual(["/usage"]);
    expect(result.outputs[0]?.text).toBe("Usage: 0 tokens");
    await expect(provider.execute("usage")).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(fake.runs).toEqual(["/usage"]);
    provider.dispose();
  });

  test("an MCP prompt omp lists is shown once, and one omp does not list is neither offered nor run", async () => {
    const fake = fakeSlashClient({
      commands: async () => ({
        commands: [...REAL_COMMAND_LIST, { name: "github:review", source: "mcp_prompt" }],
      }),
    });
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });

    const review = (await provider.searchTyped("github:review")).candidates.filter(
      (candidate) => candidate.id === "slash:mcp_prompt:github:review",
    );
    expect(review).toHaveLength(1);
    expect(review[0]?.metadata).toMatchObject({ sourceLabel: "MCP prompt" });
    expect((await provider.searchTyped("docs:summ")).candidates).toEqual([]);
    await expect(provider.route("/github:review")).resolves.toEqual({
      kind: "omp",
      command: "/github:review",
    });
    // Not in omp's list: the app does not read MCP prompts itself, so this is a normal prompt.
    await expect(provider.route("/docs:summarize")).resolves.toBeNull();
    provider.dispose();
  });

  test("when omp's list is unavailable, the app's own command is still offered, with the reason", async () => {
    const fake = fakeSlashClient();
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => ({}),
      appCommands: () => [newChat],
    });

    const result = await provider.searchTyped("");
    expect(result.state).toBe("unavailable");
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["/new"]);
    expect(result.error?.error.message).toBe("Slash commands are unavailable in this omp session.");
    provider.dispose();
  });

  test("dispose releases the catalog the provider made, and never an injected one", async () => {
    const fake = fakeSlashClient();
    const owned = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await owned.route("/usage");
    owned.dispose();
    expect(fake.unsubscribed()).toBe(1);

    const injected = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    const dispose = vi.spyOn(injected, "dispose");
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      catalog: injected,
    });
    provider.dispose();
    expect(dispose).not.toHaveBeenCalled();
    injected.dispose();
  });

  test("an app command replaces omp's command of the same name, so the name is listed once", async () => {
    const fake = fakeSlashClient();
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
      appCommands: () => [
        {
          name: "fresh",
          description: "Start a fresh connection to the model",
          run: async () => ({}),
        },
      ],
    });
    const freshes = (await provider.searchTyped("fresh")).candidates.filter(
      (candidate) => candidate.label === "/fresh",
    );
    expect(freshes).toHaveLength(1);
    expect(freshes[0]?.metadata).toMatchObject({ sourceLabel: "App" });
    provider.dispose();
  });

  test("a list that failed to load is read again on the next search, and a ready list is not", async () => {
    let calls = 0;
    const fake = fakeSlashClient({
      commands: async () => {
        calls += 1;
        if (calls === 1) {
          throw new AppFailure({
            code: "internal",
            message: "omp did not answer.",
            retryable: true,
          });
        }
        return { commands: REAL_COMMAND_LIST };
      },
    });
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    expect((await provider.searchTyped("us")).state).toBe("error");
    const recovered = await provider.searchTyped("us");
    expect(recovered.candidates.map((candidate) => candidate.label)).toContain("/usage");
    await provider.searchTyped("us");
    expect(fake.sent).toEqual(["get_available_commands", "get_available_commands"]);
    provider.dispose();
  });
});

describe("#1371 a typed command is held, not sent to the model, when omp's command list could not be read", () => {
  /** A list read that fails the way omp's own error reply does. */
  const unreadable = () =>
    fakeSlashClient({
      commands: async () => {
        throw new AppFailure({
          code: "omp_error",
          message: "omp could not list its commands.",
          retryable: true,
        });
      },
    });

  test("a typed command fails with the reason, and omp runs nothing", async () => {
    const fake = unreadable();
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await expect(provider.route("/compact")).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message:
          "/compact wasn't sent because omp's command list could not be read. omp could not list its commands.",
      },
    });
    expect(fake.runs).toEqual([]);
    provider.dispose();
  });

  test("the app's own command still routes, and text that is not a command is still a prompt", async () => {
    const fake = unreadable();
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
      appCommands: () => [newChat],
    });
    await expect(provider.route("/new")).resolves.toEqual({ kind: "app", command: newChat });
    for (const text of ["pong", " /compact", "/", "/ compact"]) {
      await expect(provider.route(text), JSON.stringify(text)).resolves.toBeNull();
    }
    provider.dispose();
  });

  test("a list that read fine but holds no commands is not unreadable, so text is a prompt", async () => {
    const fake = fakeSlashClient({ commands: async () => ({ commands: [] }) });
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await expect(provider.route("/compact")).resolves.toBeNull();
    provider.dispose();
  });

  test("a failed re-read keeps omp's last good list, so a known command still routes", async () => {
    let calls = 0;
    const fake = fakeSlashClient({
      commands: async () => {
        calls += 1;
        if (calls === 1) return { commands: REAL_COMMAND_LIST };
        throw new AppFailure({
          code: "omp_error",
          message: "omp could not list its commands.",
          retryable: true,
        });
      },
    });
    const provider = createSlashCommandProvider({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await expect(provider.route("/usage")).resolves.toEqual({ kind: "omp", command: "/usage" });
    await provider.catalog.refresh().catch(() => undefined);
    expect(provider.catalog.getSnapshot().state).toBe("stale");
    await expect(provider.route("/compact")).resolves.toEqual({
      kind: "omp",
      command: "/compact",
    });
    provider.dispose();
  });
});

describe("#2199 the note for a typed terminal-only name", () => {
  test("a typed terminal-only name has its note, and a listed row with that name takes the note away", async () => {
    const provider = createSlashCommandProvider({
      client: fakeSlashClient().client,
      threadId,
      capabilities: () => available,
    });
    expect(await provider.terminalOnlyNote("/clear")).toMatchObject({
      name: "clear",
      instead: "Use New chat instead.",
    });
    expect(await provider.terminalOnlyNote("/usage")).toBeNull();
    provider.dispose();

    const ownPlan = { name: "plan", description: "Plan this change from a file", source: "file" };
    const withOwnPlan = createSlashCommandProvider({
      client: fakeSlashClient({
        commands: async () => ({ commands: [...REAL_COMMAND_LIST, ownPlan] }),
      }).client,
      threadId,
      capabilities: () => available,
    });
    expect(await withOwnPlan.terminalOnlyNote("/plan")).toBeNull();
    expect(await withOwnPlan.terminalOnlyNote("/tree")).toMatchObject({ name: "tree" });
    withOwnPlan.dispose();
  });
});
