/**
 * Secrets saved while a chat runs (`secrets_live`), end to end on the fake model provider: omp reads `secrets.yml`
 * once, when a chat starts; a secret the app saves later is hidden from the chat's AI at once, and a command with its
 * placeholder runs with its value. The fake model calls a tool with `call_tool bash <json>`, then says what the tool
 * gave it ("tool said: …"): the chat's file keeps the model's words as the model wrote them, placeholders and all.
 * Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { YAML } from "bun";
import { chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

const STORE = resolve(import.meta.dir, "../../src/modules/A1/secrets/store.ts");

/**
 * Saves a secret the way the app does (`SecretStoreService`, as Settings → Providers → Secrets and `omp-app secret add`), in
 * another process with the chat's own folders, and gives back the placeholder the app shows for it.
 */
async function saveSecret(folder: string, name: string, value: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "omp-app-save-secret-"));
  try {
    const script = join(scratch, "save.ts");
    await writeFile(
      script,
      `import { SecretStoreService } from ${JSON.stringify(STORE)};
const store = new SecretStoreService({
  agentDir: process.env.PI_CODING_AGENT_DIR,
  hideSecrets: { isOn: async () => true, turnOn: async () => {}, onChange: () => () => {} },
});
const saved = await store.add({ name: process.env.SECRET_NAME, value: process.env.SECRET_VALUE });
process.stdout.write(saved.placeholder ?? "");
`,
    );
    const root = dirname(folder);
    const saving = Bun.spawn(["bun", script], {
      env: {
        ...Bun.env,
        HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
        SECRET_NAME: name,
        SECRET_VALUE: value,
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    const placeholder = await new Response(saving.stdout).text();
    if ((await saving.exited) !== 0 || placeholder === "")
      throw new Error("the secret was not saved");
    return placeholder;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Every line of the chat's files under its agent folder: the model's messages as omp keeps them. */
async function sessionText(folder: string): Promise<string> {
  const agentDir = join(dirname(folder), "agent");
  let text = "";
  for await (const file of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: agentDir })) {
    text += await readFile(join(agentDir, file), "utf8");
  }
  return text;
}

describe("a secret saved while a chat runs", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: is hidden from the chat's AI at once, and a command with its placeholder runs with the value`,
      async () => {
        const old = "old-secret-known-at-start-0123";
        const chat = await chats.start(command, {
          config: "secrets:\n  enabled: true\n",
          agentFiles: {
            "secrets.yml": YAML.stringify([
              { type: "plain", content: old, mode: "obfuscate", friendlyName: "OLD_ONE" },
            ]),
          },
        });
        const hello = await chat.client.hello;
        expect(hello.features ?? []).toContain("secrets_live");

        const value = "new-secret-saved-later-4567";
        const placeholder = await saveSecret(chat.folder, "NEW_TOKEN", value);
        expect(placeholder).toMatch(/^\$\$NEWTOKEN_[A-Z0-9]+(?::[ULCM])?\$\$$/);
        // The host reads the file again a moment after it changes.
        await Bun.sleep(500);

        const run = `printf %s '${placeholder}' > out.txt; cat out.txt`;
        await chat.client.request("prompt", {
          text: `call_tool bash ${JSON.stringify({ command: run })}`,
        });
        await chat.next(resultOf("1"));
        // The command ran with the value.
        expect(await readFile(join(chat.folder, "out.txt"), "utf8")).toBe(value);
        // The AI got the command's output as the placeholder: its reply, as omp keeps it, never holds the value.
        const kept = await sessionText(chat.folder);
        expect(kept).toContain(`tool said: ${placeholder}`);
        expect(kept).not.toContain(`tool said: ${value}`);
      },
      60_000,
    );
  }
});
