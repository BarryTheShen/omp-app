/**
 * `omp-app secret`: the secrets of omp's Hide Secrets from a terminal, and from a chat's commands (`… | omp-app secret
 * add NAME` saves what a command prints without the AI seeing it). It works on omp's file directly
 * (`SecretStoreService`), so the app need not run; a running app and its chats see the change by watching the file.
 * Nothing here ever prints a value.
 */
import { AppFailure, SecretAddArgs, type SecretsList } from "@omp-app/contracts";
import type { SecretStoreService } from "../modules/A1/secrets";

export type SecretCommand =
  | { readonly action: "list" }
  | { readonly action: "add" | "remove"; readonly name: string };

/** The saved secrets, one line each: the name, the placeholder a chat's AI sees, and the value's length. */
export function secretsText(list: SecretsList): string {
  const lines = [
    list.hidden
      ? "Hide Secrets is on: a chat's AI sees each secret as its placeholder, and omp puts the value in a command that uses it."
      : "Hide Secrets is off: a chat's AI sees secrets as they are. omp-app secret add turns it on, as does Settings → Providers → Secrets in the app.",
    "",
  ];
  if (list.secrets.length === 0) {
    lines.push("No secret is saved. omp-app secret add <name> saves one.");
  } else {
    const width = Math.max(...list.secrets.map((secret) => secret.name.length));
    for (const secret of list.secrets) {
      const shown = secret.placeholder ?? "(omp does not hide this value)";
      lines.push(`  ${secret.name.padEnd(width)}  ${shown}  (${secret.length} characters)`);
    }
  }
  if (list.others > 0) {
    lines.push(
      "",
      `${list.others === 1 ? "1 more entry" : `${list.others} more entries`} of ${list.path} ${list.others === 1 ? "is" : "are"} not listed: patterns, or secrets written there without a name.`,
    );
  }
  return lines.join("\n");
}

/** Runs one `omp-app secret` command and gives back what it prints. `readValue` gives the value for `add`. */
export async function runSecretCommand(
  command: SecretCommand,
  store: SecretStoreService,
  readValue: () => Promise<string>,
): Promise<string> {
  if (command.action === "list") return secretsText(await store.list());
  if (command.action === "remove") {
    await store.remove({ name: command.name });
    return `Removed ${command.name}.`;
  }
  const args = SecretAddArgs.safeParse({ name: command.name, value: (await readValue()).trim() });
  if (!args.success) {
    throw new AppFailure({
      code: "invalid_args",
      message: args.error.issues[0]?.message ?? "This is not a secret omp can save.",
      retryable: false,
    });
  }
  const saved = await store.add(args.data);
  return `Saved ${saved.name}. A chat's AI sees it as ${saved.placeholder}: a command with that placeholder gets the value.`;
}

/** What a terminal's stdin gives one key at a time: enough of `process.stdin` to read a value without showing it. */
export interface KeyInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * A secret's value: typed or pasted into a terminal, read without showing it, up to Enter; else everything that comes
 * in (a pipe). Ctrl+C or Ctrl+D with nothing typed gives "".
 */
export async function readSecretValue(
  input: KeyInput,
  name: string,
  readPiped: () => Promise<string>,
  prompt: (text: string) => void,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) return readPiped();
  prompt(`Paste or type the value of ${name} (it is not shown), then press Enter: `);
  input.setRawMode(true);
  const { promise, resolve } = Promise.withResolvers<string>();
  let value = "";
  const onData = (chunk: Buffer | string) => {
    for (const char of String(chunk)) {
      if (char === "\r" || char === "\n") return resolve(value);
      if (char === "\u0003" || char === "\u0004") return resolve("");
      if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
      else value += char;
    }
  };
  input.on("data", onData);
  input.resume();
  try {
    return await promise;
  } finally {
    input.off("data", onData);
    input.setRawMode(false);
    input.pause();
    prompt("\n");
  }
}
