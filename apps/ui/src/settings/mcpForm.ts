import {
  MCP_SECRET_MASK,
  type McpConfigServer,
  McpConfigServerName,
  type McpServerConfig,
} from "@omp-app/contracts";

/** How omp reaches a server: a local command, or a remote one over HTTP or SSE. */
export type McpKind = McpServerConfig["type"];
export type McpScope = McpConfigServer["scope"];

/** An argument that names a secret (`--token`, `--api-key=…`), as `/mcp add` refuses them: its value is masked in the list. */
const SECRET_ARG = /(?:^|[-_])(token|secret|password|api[-_]?key|authorization)(?:$|[-_=])/i;

/**
 * How a server runs, as the list shows it (#16): its command and arguments, with the value of an argument that names a
 * secret masked; or its address's origin alone, as the path and query of an MCP address can carry its key (the list of
 * `/mcp` showed origins only for that reason). The editor shows them whole, for editing.
 */
export function reachWords(config: McpServerConfig): string {
  if (config.type !== "stdio") {
    try {
      return new URL(config.url ?? "").origin;
    } catch {
      return "";
    }
  }
  const args = config.args ?? [];
  const shown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!SECRET_ARG.test(arg)) {
      shown.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      shown.push(`${arg.slice(0, equals + 1)}${MCP_SECRET_MASK}`);
      continue;
    }
    shown.push(arg);
    if (index + 1 < args.length) {
      shown.push(MCP_SECRET_MASK);
      index += 1;
    }
  }
  return [config.command ?? "", ...shown].join(" ");
}

/**
 * One environment variable or header as typed. `savedKey` is the name a saved value stands behind (the page never gets
 * a saved value, #16): left empty under that name, the saved value stays.
 */
export interface McpPair {
  readonly key: string;
  readonly value: string;
  readonly savedKey: string | null;
}

/** The editor's fields (#16), all as typed. */
export interface McpForm {
  readonly name: string;
  readonly scope: McpScope;
  readonly kind: McpKind;
  readonly command: string;
  /** One argument a line. */
  readonly args: string;
  readonly env: readonly McpPair[];
  readonly cwd: string;
  readonly url: string;
  readonly headers: readonly McpPair[];
  /** Seconds; empty for omp's own. */
  readonly timeout: string;
  /** Kept as the server had it. */
  readonly enabled: boolean | undefined;
}

export function emptyForm(scope: McpScope): McpForm {
  return {
    name: "",
    scope,
    kind: "stdio",
    command: "",
    args: "",
    env: [],
    cwd: "",
    url: "",
    headers: [],
    timeout: "",
    enabled: undefined,
  };
}

const pairsOf = (values: Readonly<Record<string, string>> | undefined): McpPair[] =>
  Object.entries(values ?? {}).map(([key, value]) =>
    value === MCP_SECRET_MASK ? { key, value: "", savedKey: key } : { key, value, savedKey: null },
  );

/** A saved server's form: each saved secret an empty field standing for it. */
export function formOf(server: McpConfigServer): McpForm {
  const { config } = server;
  return {
    name: server.name,
    scope: server.scope,
    kind: config.type,
    command: config.command ?? "",
    args: (config.args ?? []).join("\n"),
    env: pairsOf(config.env),
    cwd: config.cwd ?? "",
    url: config.url ?? "",
    headers: pairsOf(config.headers),
    timeout: config.timeout === undefined ? "" : String(config.timeout / 1000),
    enabled: config.enabled,
  };
}

/** The pairs as omp keeps them; a saved value left empty under its own name goes back as the mask, which keeps it. */
function valuesOf(
  pairs: readonly McpPair[],
  what: "variable" | "header",
): Record<string, string> | string {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key === "" && pair.value === "") continue;
    if (key === "") return `A ${what} needs its name.`;
    const same = what === "header" ? key.toLowerCase() : key;
    if (seen.has(same)) return `Two ${what}s are named ${key}.`;
    seen.add(same);
    if (pair.savedKey !== null && pair.value === "") {
      if (key !== pair.savedKey)
        return `Type the value of ${key} again: its saved value is under ${pair.savedKey}.`;
      values[key] = MCP_SECRET_MASK;
    } else {
      values[key] = pair.value;
    }
  }
  return values;
}

/** The server omp writes from the form, or what to fix first, in words. */
export function configOf(
  form: McpForm,
): { readonly name: string; readonly config: McpServerConfig } | { readonly problem: string } {
  const name = form.name.trim();
  if (!McpConfigServerName.safeParse(name).success) {
    return {
      problem:
        name === ""
          ? "The server needs a name."
          : "Name it with letters, digits, '.', ':', '-', '_' and single spaces.",
    };
  }
  let timeout: number | undefined;
  if (form.timeout.trim() !== "") {
    const seconds = Number(form.timeout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0)
      return { problem: "The timeout is a number of seconds." };
    timeout = Math.round(seconds * 1000);
  }
  const common = {
    ...(form.enabled === undefined ? {} : { enabled: form.enabled }),
    ...(timeout === undefined ? {} : { timeout }),
  };
  if (form.kind === "stdio") {
    const command = form.command.trim();
    if (command === "") return { problem: "A local server needs the command that starts it." };
    const env = valuesOf(form.env, "variable");
    if (typeof env === "string") return { problem: env };
    const args = form.args
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim() !== "");
    const cwd = form.cwd.trim();
    return {
      name,
      config: {
        type: "stdio",
        command,
        ...(args.length === 0 ? {} : { args }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
        ...(cwd === "" ? {} : { cwd }),
        ...common,
      },
    };
  }
  const url = form.url.trim();
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {}
  if (protocol !== "http:" && protocol !== "https:") {
    return { problem: "The server's address starts with https:// or http://." };
  }
  const headers = valuesOf(form.headers, "header");
  if (typeof headers === "string") return { problem: headers };
  return {
    name,
    config: {
      type: form.kind,
      url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...common,
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const looksLikeServer = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && (typeof value.command === "string" || typeof value.url === "string");

const textPairs = (value: unknown): McpPair[] =>
  isObject(value)
    ? Object.entries(value).map(([key, each]) => ({
        key,
        value: typeof each === "string" ? each : JSON.stringify(each),
        savedKey: null,
      }))
    : [];

/**
 * A form from JSON as MCP pages publish it (#16): `{"mcpServers": {...}}` (omp, Claude, Cursor), `{"servers": {...}}`
 * (VS Code), `{"<name>": {...}}`, or one server's own object. With several servers the form takes the first, and says
 * so. The form keeps `scope`; anything else comes from the JSON.
 */
export function formFromJson(
  text: string,
  scope: McpScope,
): { readonly form: McpForm; readonly note: string | null } | { readonly problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "This is not JSON: check its quotes, commas and brackets." };
  }
  if (!isObject(parsed)) return { problem: "Paste an object: { … }." };
  let entries: [string, unknown][];
  if (isObject(parsed.mcpServers)) entries = Object.entries(parsed.mcpServers);
  else if (isObject(parsed.servers)) entries = Object.entries(parsed.servers);
  else if (looksLikeServer(parsed)) entries = [["", parsed]];
  else entries = Object.entries(parsed).filter(([, value]) => looksLikeServer(value));
  const servers = entries.filter((entry): entry is [string, Record<string, unknown>] =>
    looksLikeServer(entry[1]),
  );
  const first = servers[0];
  if (first === undefined) {
    return { problem: "No MCP server in this JSON: a server has a command or a url." };
  }
  const [key, server] = first;
  const remote = typeof server.url === "string";
  const kind: McpKind = !remote ? "stdio" : server.type === "sse" ? "sse" : "http";
  const timeout = typeof server.timeout === "number" && server.timeout > 0 ? server.timeout : null;
  const form: McpForm = {
    ...emptyForm(scope),
    name: McpConfigServerName.safeParse(key).success ? key : "",
    kind,
    command: typeof server.command === "string" ? server.command : "",
    args: Array.isArray(server.args) ? server.args.map((arg) => String(arg)).join("\n") : "",
    env: textPairs(server.env),
    cwd: typeof server.cwd === "string" ? server.cwd : "",
    url: typeof server.url === "string" ? server.url : "",
    headers: textPairs(server.headers),
    timeout: timeout === null ? "" : String(timeout / 1000),
    enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
  };
  const note =
    servers.length > 1
      ? `This JSON has ${servers.length} servers: the form has the first, ${key}. Add the others one at a time.`
      : key === "" || form.name !== ""
        ? null
        : `${key} is not a name omp takes: name the server here.`;
  return { form, note };
}
