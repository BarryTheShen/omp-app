import { type FSWatcher, watch } from "node:fs";
import { basename, join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
  BeforeProviderRequestEvent,
  ContextEvent,
  ContextEventResult,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
  buildSecretObfuscator,
  getSecretPlaceholderKey,
  loadSecrets,
  SecretObfuscator,
} from "@oh-my-pi/pi-coding-agent/secrets/index";
import { obfuscateMessages } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import type { SecretEntry } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { cfgSecretsEnabled } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { logger } from "@oh-my-pi/pi-utils";

const FILE = "secrets.yml";
/** Writes come as a burst (a new file renamed over the old): one rebuild after it settles. */
const SETTLE_MS = 100;
/**
 * The messages omp's own obfuscation hides secrets in (`obfuscateMessageBatch`): the person's, tool results, the AI's
 * replies, and developer messages the person sent. The agent's own notes (a finished background job's, which quotes its
 * command and output; summaries; extensions' messages) go to the model as other developer messages, which it passes over.
 */
function ompHides(message: AgentMessage): boolean {
  switch (message.role) {
    case "user":
    case "toolResult":
    case "assistant":
      return true;
    case "developer":
      return message.attribution === "user";
    default:
      return false;
  }
}

/**
 * The tools a saved secret's value is filled into: commands, which the person reads in full in the tool card. Any other
 * tool call that carries a placeholder (a file write, a page fetch, an MCP tool, a to-do, a question) is refused.
 */
const COMMANDS: ReadonlySet<string> = new Set(["bash", "eval"]);

/** Visits every string in a tool call's arguments. */
function eachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) eachString(item, visit);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) eachString(item, visit);
}

/** Where the chat's omp reads secrets: its agent folder's file and the folder's own `.omp/secrets.yml`. */
export interface LiveSecretsPlace {
  readonly cwd: string;
  readonly agentDir: string;
  /** The agent folder omp was given, if any: its placeholder key is kept there then (`buildSecretObfuscator`). */
  readonly keyDir: string | undefined;
}

/**
 * Secrets saved while a chat runs. omp reads `secrets.yml` once, when a chat starts (or when Hide Secrets first comes
 * on), and hides secrets from the AI, and fills them into a tool call when it runs, with the obfuscator it built then.
 * This keeps a running chat in step with the file (Settings → Providers → Secrets, `omp-app secret add`, an edit by
 * hand): omp's own obfuscator is extended (`#extend`) so that it fills in the secrets saved since, when a call runs, and
 * the call is saved as the model wrote it, placeholders and all; a secret omp's obfuscator does not know is hidden in
 * what goes to the AI (`context`, which runs before omp's own hiding); the session's own obfuscator, which the chat's
 * events show values with, is the one built from the file as it is now. The messages omp's own hiding passes over
 * (`ompHides`) are hidden here with every secret, and each request gets a last look before it leaves. A secret's value
 * goes only into commands (`COMMANDS`): any other tool call that carries a placeholder is refused before it runs, as is
 * a call that would get the value of a secret removed since (omp's obfuscator keeps filling those in).
 */
export class LiveSecrets {
  #session: AgentSession | undefined;
  #settings: Settings | undefined;
  #place: LiveSecretsPlace | undefined;
  /** The obfuscator omp hides and fills in with: the one it started with, or built when Hide Secrets came on. */
  #omps: SecretObfuscator | undefined;
  /** Built from the files as they are now: every secret, for filling in and for the chat's events. */
  #current: SecretObfuscator | undefined;
  /** The secrets of the files that omp's obfuscator does not know, for hiding what goes to the AI. */
  #extra: SecretObfuscator | undefined;
  /** Every value this chat has seen saved, with its name: omp's obfuscator keeps those it was built with. */
  readonly #seen = new Map<string, string | undefined>();
  /** The values saved in the files now. */
  #saved: ReadonlySet<string> = new Set();
  /** Every value this chat has seen saved, for the last look at each request before it leaves. */
  #plain: SecretObfuscator | undefined;
  /** omp's own obfuscators this chat has extended (`#extend`), once each. */
  readonly #extended = new WeakSet<SecretObfuscator>();
  readonly #watchers: FSWatcher[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopListening: (() => void) | undefined;
  #reloading: Promise<void> = Promise.resolve();

  /** The hooks, given to omp with the session (`createAgentSession({ extensions })`). */
  readonly extension: ExtensionFactory = (api) => {
    api.on("context", (event) => this.#context(event));
    api.on("tool_call", (event) => this.#toolCall(event));
    api.on("before_provider_request", (event) => this.#beforeRequest(event));
  };

  /** Starts following the files and Hide Secrets, once the session exists. */
  attach(session: AgentSession, settings: Settings, place: LiveSecretsPlace): void {
    this.#session = session;
    this.#settings = settings;
    this.#place = place;
    this.#omps = session.obfuscator;
    this.#current = session.obfuscator;
    if (this.#omps !== undefined) this.#extend(this.#omps);
    for (const dir of [place.agentDir, join(place.cwd, ".omp")]) {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename == null || basename(String(filename)) === FILE) this.#schedule();
        });
        watcher.on("error", () => watcher.close());
        this.#watchers.push(watcher);
      } catch {
        // A folder with no `.omp` has no secrets of its own; one made later is read when the chat starts again.
      }
    }
    this.#stopListening = cfgSecretsEnabled.listen(settings, () => this.#schedule());
    // What omp's obfuscator was built with, so a secret removed later is known as removed.
    this.#reloading = this.#reloading
      .then(async () => this.#remember(await loadSecrets(place.cwd, place.agentDir)))
      .catch((error: unknown) =>
        logger.warn("Saved secrets were not read", { error: String(error) }),
      );
  }

  dispose(): void {
    for (const watcher of this.#watchers.splice(0)) watcher.close();
    clearTimeout(this.#timer);
    this.#stopListening?.();
  }

  /** Builds the obfuscators from the files as they are now; resolves once they are in use. */
  reload(): Promise<void> {
    this.#reloading = this.#reloading
      .then(() => this.#reload())
      .catch((error: unknown) =>
        logger.warn("Saved secrets were not reloaded", { error: String(error) }),
      );
    return this.#reloading;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.reload(), SETTLE_MS);
    this.#timer.unref?.();
  }

  /**
   * omp builds an obfuscator of its own when Hide Secrets first comes on, and hands it to the session: one the session
   * holds that is not this class's is omp's. Says whether it is a new one.
   */
  #followOmp(): boolean {
    const installed = this.#session?.obfuscator;
    if (installed === undefined || installed === this.#current || installed === this.#omps)
      return false;
    this.#omps = installed;
    this.#extend(installed);
    return true;
  }

  #hiding(): boolean {
    return this.#settings !== undefined && cfgSecretsEnabled.get(this.#settings);
  }

  async #reload(): Promise<void> {
    const session = this.#session;
    const place = this.#place;
    if (session === undefined || place === undefined) return;
    this.#followOmp();
    if (!this.#hiding()) {
      // omp turns its own obfuscator off; the one the session holds may be this class's.
      session.obfuscator?.setObfuscating(false);
      this.#extra = undefined;
      return;
    }
    const built = await buildSecretObfuscator(place.cwd, place.agentDir, place.keyDir);
    const omps = this.#omps;
    const entries = await loadSecrets(place.cwd, place.agentDir);
    await this.#remember(entries);
    const unknown = entries.filter(
      (entry) =>
        entry.type === "plain" &&
        (omps === undefined || omps.obfuscate(entry.content) === entry.content),
    );
    this.#extra =
      unknown.length === 0
        ? undefined
        : new SecretObfuscator(unknown, await getSecretPlaceholderKey(place.keyDir));
    if (built === undefined) return;
    built.setObfuscating(true);
    this.#current = built;
    session.setObfuscator(built);
  }

  async #context(event: ContextEvent): Promise<ContextEventResult | undefined> {
    // omp's own obfuscator came after the last rebuild: what it does not know is worked out again.
    if (this.#followOmp()) await this.reload();
    if (!this.#hiding()) return undefined;
    const every = this.#current ?? this.#omps;
    if (every === undefined || !every.hasSecrets()) return undefined;
    const walked = event.messages.map((message) =>
      ompHides(message) ? message : (every.obfuscateObject(message) as AgentMessage),
    );
    // The messages omp hides itself get only what its obfuscator does not know.
    const extra = this.#extra;
    return {
      messages:
        extra === undefined
          ? walked
          : (obfuscateMessages(extra, walked as Message[]) as AgentMessage[]),
    };
  }

  #toolCall(event: ToolCallEvent): ToolCallEventResult | undefined {
    this.#followOmp();
    // omp's own obfuscator, extended with the secrets saved since; else the files' one.
    const fill = this.#omps ?? this.#current;
    if (fill === undefined || !this.#hiding()) return undefined;
    let removed: string | undefined;
    let carried: string | undefined;
    eachString(event.input, (text) => {
      if (!text.includes("$$")) return;
      const filled = fill.deobfuscate(text);
      if (filled === text) return;
      const secret = this.#filledIn(filled, text);
      if (secret?.removed === true) removed ??= secret.name;
      else carried ??= secret?.name ?? "a saved secret";
    });
    if (removed !== undefined) {
      return {
        block: true,
        reason: `This uses the secret ${removed}, which has been removed from the saved secrets, so it is not filled in. Ask for it to be saved again if it is still needed.`,
      };
    }
    // A command runs with the value: omp fills it in when the call runs, so the call is saved with the placeholder.
    if (carried === undefined || COMMANDS.has(event.toolName)) return undefined;
    return {
      block: true,
      reason: `Saved secrets are filled in only for commands (${[...COMMANDS].join(", ")}), and this ${event.toolName} call holds the placeholder of ${carried}. Put the value where it is needed with a command instead.`,
    };
  }

  /**
   * Extends omp's own obfuscator in place. omp fills a tool call's arguments when the call runs through its public
   * `hasSecrets` and `deobfuscate` (`deobfuscateToolArguments`), and has no way to take in a secret saved later; those
   * two are given the secrets of the files as they are now (`#current`), so omp fills a later secret itself, at run
   * time, and the call is saved as the model wrote it. Once per obfuscator; one omp builds later is extended too.
   */
  #extend(omps: SecretObfuscator): void {
    if (this.#extended.has(omps)) return;
    this.#extended.add(omps);
    const ownFill = omps.deobfuscate.bind(omps);
    const ownHas = omps.hasSecrets.bind(omps);
    // The files' obfuscator, unless it is this one (before the first rebuild), which would only fill itself again.
    const later = (): SecretObfuscator | undefined => {
      const current = this.#current;
      return current === undefined || current === omps ? undefined : current;
    };
    omps.deobfuscate = (text: string): string => {
      const filled = ownFill(text);
      const current = later();
      return current === undefined || !filled.includes("$$") ? filled : current.deobfuscate(filled);
    };
    omps.hasSecrets = (): boolean => ownHas() || (later()?.hasSecrets() ?? false);
  }

  /** The last look at a request before it leaves, for what omp's own hiding passes over (the system prompt, its
   * compaction, side questions and advisors): every value this chat has seen saved becomes its placeholder. */
  #beforeRequest(event: BeforeProviderRequestEvent): unknown {
    const plain = this.#plain;
    if (plain === undefined || !this.#hiding()) return undefined;
    const payload = plain.obfuscateObject(event.payload);
    return payload === event.payload ? undefined : payload;
  }

  async #remember(entries: readonly SecretEntry[]): Promise<void> {
    const saved = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== "plain") continue;
      saved.add(entry.content);
      this.#seen.set(entry.content, entry.friendlyName);
    }
    this.#saved = saved;
    if (this.#seen.size === 0 || this.#place === undefined) return;
    this.#plain = new SecretObfuscator(
      [...this.#seen].map(([content, friendlyName]) => ({
        type: "plain" as const,
        content,
        mode: "obfuscate" as const,
        friendlyName,
      })),
      await getSecretPlaceholderKey(this.#place.keyDir),
    );
  }

  /**
   * The saved secret whose value filling in put into `filled`, where `written` did not hold it, and whether it has been
   * removed since; a removed one first.
   */
  #filledIn(
    filled: string,
    written: string,
  ): { readonly name: string; readonly removed: boolean } | undefined {
    let found: { readonly name: string; readonly removed: boolean } | undefined;
    for (const [value, name] of this.#seen) {
      if (!filled.includes(value) || written.includes(value)) continue;
      const removed = !this.#saved.has(value);
      if (removed) return { name: name ?? "a saved secret", removed };
      found ??= { name: name ?? "a saved secret", removed };
    }
    return found;
  }
}
