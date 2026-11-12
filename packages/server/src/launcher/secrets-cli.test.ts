import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSecretPlaceholderKey } from "@oh-my-pi/pi-coding-agent/secrets/index";
import { AppFailure } from "@omp-app/contracts";
import { SecretStoreService } from "../modules/A1/secrets";
import { parseLauncherArgs } from "./launcher";
import { type KeyInput, readSecretValue, runSecretCommand } from "./secrets-cli";

let root: string | null = null;
afterEach(async () => {
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

async function store(): Promise<SecretStoreService> {
  root = await mkdtemp(join(tmpdir(), "omp-app-secret-cli-"));
  let on = false;
  return new SecretStoreService({
    agentDir: join(root, "agent"),
    hideSecrets: {
      isOn: async () => on,
      turnOn: async () => {
        on = true;
      },
      onChange: () => () => undefined,
    },
    placeholderKey: () => getSecretPlaceholderKey(join(root as string, "keys")),
  });
}

/** A terminal that types `keys` as one paste once the value is asked for. */
function terminal(keys: string): KeyInput & { readonly raw: boolean[] } {
  const listeners = new Set<(chunk: string) => void>();
  const raw: boolean[] = [];
  return {
    isTTY: true,
    raw,
    setRawMode: (mode: boolean) => raw.push(mode),
    on: (_event, listener) => listeners.add(listener as (chunk: string) => void),
    off: (_event, listener) => listeners.delete(listener as (chunk: string) => void),
    resume: () => queueMicrotask(() => [...listeners].forEach((listener) => listener(keys))),
    pause: () => undefined,
  };
}

describe("omp-app secret", () => {
  test("the command line takes a list, an add or a remove by name, and nothing else", () => {
    expect(parseLauncherArgs(["secret"])).toMatchObject({ args: { secret: { action: "list" } } });
    expect(parseLauncherArgs(["secret", "list"])).toMatchObject({
      args: { command: "secret", secret: { action: "list" } },
    });
    expect(parseLauncherArgs(["secret", "add", "API_KEY"])).toMatchObject({
      args: { secret: { action: "add", name: "API_KEY" } },
    });
    expect(parseLauncherArgs(["secret", "remove", "API_KEY"])).toMatchObject({
      args: { secret: { action: "remove", name: "API_KEY" } },
    });
    // A value on the command line would land in the shell's history: it comes in on stdin only.
    expect(parseLauncherArgs(["secret", "add", "API_KEY", "the-value"])).toEqual({
      ok: false,
      message: "Use omp-app secret, omp-app secret add <name>, or omp-app secret remove <name>.",
    });
    expect(parseLauncherArgs(["secret", "add", "my key"])).toEqual({
      ok: false,
      message:
        "\"my key\" cannot name a secret: use letters, digits, '_', '.' and '-', starting with a letter or digit.",
    });
  });

  test("add saves what a command printed, trimmed, and prints the placeholder, never the value", async () => {
    const secrets = await store();
    const value = "4f9c2d7e8a1b3c5d6e7f8091a2b3c4d5";
    const printed = await runSecretCommand(
      { action: "add", name: "API_KEY" },
      secrets,
      async () => `${value}\n`,
    );
    const [saved] = (await secrets.list()).secrets;
    expect(printed).toBe(
      `Saved API_KEY. A chat's AI sees it as ${saved?.placeholder}: a command with that placeholder gets the value.`,
    );
    expect(printed).not.toContain(value);
    expect(await secrets.reveal({ name: "API_KEY" })).toEqual({ value });

    const listed = await runSecretCommand({ action: "list" }, secrets, async () => "");
    expect(listed).toContain("Hide Secrets is on");
    expect(listed).toContain(`  API_KEY  ${saved?.placeholder}  (32 characters)`);
    expect(listed).not.toContain(value);
    expect(
      await runSecretCommand({ action: "remove", name: "API_KEY" }, secrets, async () => ""),
    ).toBe("Removed API_KEY.");
  });

  test("an empty or short value is refused in words", async () => {
    const secrets = await store();
    const refusal = runSecretCommand({ action: "add", name: "EMPTY" }, secrets, async () => "\n");
    await expect(refusal).rejects.toBeInstanceOf(AppFailure);
    await expect(refusal).rejects.toThrow("omp hides secrets of 8 characters or more.");
    expect((await secrets.list()).secrets).toEqual([]);
  });

  test("typed into a terminal, the value is read without echo up to Enter, with Backspace; Ctrl+C gives none", async () => {
    const prompts: string[] = [];
    const typed = terminal("hunter2-secret\u007fT\r");
    const value = await readSecretValue(
      typed,
      "API_KEY",
      async () => "piped",
      (text) => prompts.push(text),
    );
    expect(value).toBe("hunter2-secreT");
    expect(typed.raw).toEqual([true, false]);
    expect(prompts.join("")).not.toContain("hunter2");
    expect(
      await readSecretValue(
        terminal("abc\u0003"),
        "X",
        async () => "piped",
        () => undefined,
      ),
    ).toBe("");
    // Not a terminal: everything that came in.
    expect(
      await readSecretValue(
        { ...terminal(""), isTTY: false },
        "X",
        async () => "from a pipe\n",
        () => undefined,
      ),
    ).toBe("from a pipe\n");
  });

  test("a paste of several lines is refused, not cut to its first line, and the terminal is given back", async () => {
    for (const pasted of [
      "first-line-of-it\nsecond-line-of-it\n",
      "-----BEGIN PRIVATE KEY-----\r",
    ]) {
      const typed = terminal(pasted);
      await expect(
        readSecretValue(
          typed,
          "DEPLOY_KEY",
          async () => "piped",
          () => undefined,
        ),
      ).rejects.toThrow("Pipe it in instead: … | omp-app secret add DEPLOY_KEY");
      expect(typed.raw).toEqual([true, false]);
    }
  });
});
