import { join } from "node:path";
import {
  addMCPServer,
  readMCPConfigFile,
  removeMCPServer,
  setMcpServerEnabled,
  updateMCPServer,
  validateServerName,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPConfigFile, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
  AppFailure,
  MCP_SECRET_MASK,
  type McpConfigListResult,
  type McpConfigNameArgs,
  type McpConfigSaveArgs,
  McpConfigServer,
  type McpConfigSetEnabledArgs,
  type McpServerConfig,
} from "@omp-app/contracts";

type Scope = McpConfigServer["scope"];

const refused = (message: string): AppFailure =>
  new AppFailure({ code: "invalid_args", message, retryable: false });

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** A saved value as a page gets it: an empty one as it is, any other as the mask. */
function masked(
  values: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === "" ? "" : MCP_SECRET_MASK]),
  );
}

/**
 * A page's values over the saved ones: a masked value keeps the saved one of its name; one with no saved value of that
 * name (a renamed key) is refused in words, as its value would be lost.
 */
function unmasked(
  edited: Readonly<Record<string, string>> | undefined,
  saved: Readonly<Record<string, string>> | undefined,
  what: string,
): Record<string, string> | undefined {
  if (edited === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(edited).map(([key, value]) => {
      if (value !== MCP_SECRET_MASK) return [key, value];
      const kept = saved?.[key];
      if (kept === undefined)
        throw refused(`Type the value of ${what} ${key} again: none is saved under that name.`);
      return [key, kept];
    }),
  );
}

/** A server's config as a page gets it: its env and header values masked, its sign-in left out. */
export function forPage(config: MCPServerConfig): McpServerConfig {
  const common = {
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.timeout === undefined ? {} : { timeout: Math.round(config.timeout) }),
  };
  if (config.type === "http" || config.type === "sse") {
    const headers = masked(config.headers);
    return {
      type: config.type,
      url: config.url,
      ...(headers === undefined ? {} : { headers }),
      ...common,
    };
  }
  const env = masked(config.env);
  return {
    type: "stdio",
    command: config.command,
    ...(config.args === undefined ? {} : { args: [...config.args] }),
    ...(env === undefined ? {} : { env }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...common,
  };
}

/** A page's config written over the saved one: masked values and omp's own sign-in fields kept. */
export function fromPage(
  edited: McpServerConfig,
  saved: MCPServerConfig | undefined,
): MCPServerConfig {
  const kept = {
    ...(saved?.auth === undefined ? {} : { auth: saved.auth }),
    ...(saved?.oauth === undefined ? {} : { oauth: saved.oauth }),
    ...(edited.enabled === undefined ? {} : { enabled: edited.enabled }),
    ...(edited.timeout === undefined ? {} : { timeout: edited.timeout }),
  };
  if (edited.type === "stdio") {
    if (edited.command === undefined) throw refused("A local server needs its command.");
    const savedEnv =
      saved !== undefined && saved.type !== "http" && saved.type !== "sse" ? saved.env : undefined;
    const env = unmasked(edited.env, savedEnv, "the variable");
    return {
      ...kept,
      type: "stdio",
      command: edited.command,
      ...(edited.args === undefined ? {} : { args: [...edited.args] }),
      ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
      ...(edited.cwd === undefined ? {} : { cwd: edited.cwd }),
    };
  }
  if (edited.url === undefined) throw refused("A remote server needs its URL.");
  const savedHeaders = saved?.type === "http" || saved?.type === "sse" ? saved.headers : undefined;
  const headers = unmasked(edited.headers, savedHeaders, "the header");
  return {
    ...kept,
    type: edited.type,
    url: edited.url,
    ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

/**
 * omp's MCP servers as its config files keep them (#16): the user's (`<agent folder>/mcp.json`) and a folder's
 * (`<folder>/.omp/mcp.json`), read and written with omp's own config code, so the files keep omp's format and checks.
 */
export class McpConfigService {
  readonly #agentDir: string;

  constructor(agentDir: string) {
    this.#agentDir = agentDir;
  }

  pathOf(scope: Scope, folder: string): string {
    return scope === "user" ? join(this.#agentDir, "mcp.json") : join(folder, ".omp", "mcp.json");
  }

  /**
   * Every server in the user's file, then the folder's, as a page gets it, Enabled as omp reads it: a name on the user's
   * denylist (`disabledServers`) is off whatever its file says, one on the allowlist (`enabledServers`) on. A server the
   * page cannot show (a name omp's own code refuses, a config past the page's limits) is left out, and as it is.
   */
  async servers(folder: string): Promise<McpConfigListResult> {
    const servers: McpConfigServer[] = [];
    const userPath = this.pathOf("user", folder);
    const user = await readMCPConfigFile(userPath).catch((): MCPConfigFile => ({}));
    const denied = new Set(user.disabledServers ?? []);
    const allowed = new Set(user.enabledServers ?? []);
    for (const scope of ["user", "project"] as const) {
      const path = this.pathOf(scope, folder);
      const file =
        scope === "user" ? user : await readMCPConfigFile(path).catch((): MCPConfigFile => ({}));
      for (const [name, config] of Object.entries(file.mcpServers ?? {})) {
        if (validateServerName(name) !== undefined) continue;
        const page = forPage(config);
        const enabled = denied.has(name) ? false : allowed.has(name) ? true : page.enabled;
        const server = McpConfigServer.safeParse({
          name,
          scope,
          path,
          config: enabled === undefined ? page : { ...page, enabled },
          auth: config.auth?.type ?? (config.oauth === undefined ? "none" : "oauth"),
        });
        if (server.success) servers.push(server.data);
      }
    }
    return { servers: servers.slice(0, 256) };
  }

  async save(args: McpConfigSaveArgs): Promise<void> {
    const invalid = validateServerName(args.name);
    if (invalid !== undefined) throw refused(invalid);
    const path = this.pathOf(args.scope, args.folder);
    const file = await readMCPConfigFile(path);
    const renamed = args.previousName !== null && args.previousName !== args.name;
    const saved = file.mcpServers?.[args.previousName ?? args.name];
    if (renamed && file.mcpServers?.[args.name] !== undefined) {
      throw refused(`A server named ${args.name} is already there.`);
    }
    const config = fromPage(args.config, saved);
    try {
      if (saved === undefined || renamed) await addMCPServer(path, args.name, config);
      else await updateMCPServer(path, args.name, config);
      // The new name is written before the old goes, so a failed write loses nothing.
      if (renamed && args.previousName !== null) await removeMCPServer(path, args.previousName);
    } catch (failure) {
      if (failure instanceof AppFailure) throw failure;
      throw refused(words(failure));
    }
  }

  async remove(args: McpConfigNameArgs): Promise<void> {
    try {
      await removeMCPServer(this.pathOf(args.scope, args.folder), args.name);
    } catch (failure) {
      throw refused(words(failure));
    }
  }

  async setEnabled(args: McpConfigSetEnabledArgs): Promise<void> {
    await setMcpServerEnabled({
      userPath: this.pathOf("user", args.folder),
      projectPath: this.pathOf("project", args.folder),
      sourcePath: this.pathOf(args.scope, args.folder),
      name: args.name,
      enabled: args.enabled,
    });
  }
}
