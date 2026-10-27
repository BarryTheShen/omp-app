/**
 * The app's tools and URI schemes in omp's session (SDK plan H5.2e), as omp's RPC bridges build them (18.12.6
 * `modes/rpc/host-tools.ts`, `host-uris.ts`), over the protocol's host requests.
 * - A tool's call is a `tool.call` request. The server may send progress (`host_tool_update`) before its answer; an
 *   answer with `isError` fails the call with its text.
 * - A scheme's read or write is a `uri.read` or `uri.write` request, through omp's process-wide URL router.
 * - omp's abort fails the call, read or write and tells the server (`tool_cancel`, `uri_cancel`); a late answer is
 *   dropped. When the server's lines end, waiting calls fail (`HostRequests.closeAll`) and the schemes leave the router.
 */
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { applyToolProxy } from "@oh-my-pi/pi-coding-agent/extensibility/tool-proxy";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type {
  InternalResource,
  InternalUrl,
  ProtocolHandler,
  ResolveContext,
  SchemeSpec,
  WriteContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { defaultLoadModeForToolName } from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import type {
  ChatHostHostMethod,
  ChatHostHostMethodMap,
  HostToolDefinition,
  HostUriSchemeDefinition,
  ToolCallAnswer,
  ToolCancelEvent,
  UriCancelEvent,
} from "@omp-app/contracts/chat-host";
import type { HostRequests } from "./ui-context";

/** A host tool's definition after omp's checks (`normalizeHostToolDefinitions`, `rpc-mode.ts:980-1004`). */
interface CheckedHostTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly hidden: boolean;
  readonly loadMode: ToolLoadMode;
  readonly readsSkillUris?: boolean;
}

/** omp's checks of the app's tool definitions: a name, a description and a schema object each. */
export function checkHostTools(tools: readonly HostToolDefinition[]): CheckedHostTool[] {
  return tools.map((tool, index) => {
    const name = tool.name.trim();
    if (!name) throw new Error(`Host tool at index ${index} must provide a non-empty name`);
    const description = tool.description.trim();
    if (!description) throw new Error(`Host tool "${name}" must provide a non-empty description`);
    if (Array.isArray(tool.parameters))
      throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
    return {
      name,
      label: tool.label?.trim() || name,
      description,
      parameters: tool.parameters,
      hidden: tool.hidden === true,
      loadMode: defaultLoadModeForToolName(name, tool.loadMode),
      ...(tool.readsSkillUris !== undefined ? { readsSkillUris: tool.readsSkillUris } : {}),
    };
  });
}

/** One request that omp's signal can cancel; `cancelled` tells the server and fails the caller with `abortMessage`. */
function cancellable<M extends ChatHostHostMethod>(
  requests: HostRequests,
  method: M,
  params: ChatHostHostMethodMap[M]["params"],
  signal: AbortSignal | undefined,
  cancelled: (requestId: string) => void,
  abortMessage: string,
  onSent?: (requestId: string) => () => void,
): Promise<ChatHostHostMethodMap[M]["result"]> {
  if (signal?.aborted) return Promise.reject(new Error(abortMessage));
  const { id, answer } = requests.send(method, params);
  const stopWatchingUpdates = onSent?.(id);
  const { promise, resolve, reject } = Promise.withResolvers<ChatHostHostMethodMap[M]["result"]>();
  const done = (): void => {
    signal?.removeEventListener("abort", abort);
    stopWatchingUpdates?.();
  };
  function abort(): void {
    done();
    requests.forget(id);
    cancelled(id);
    reject(new Error(abortMessage));
  }
  signal?.addEventListener("abort", abort, { once: true });
  answer.then(
    (value) => {
      done();
      resolve(value);
    },
    (error: Error) => {
      done();
      reject(error);
    },
  );
  return promise;
}

/** The app's tools; each call goes to the server and waits for its answer. */
export class HostTools {
  readonly #requests: HostRequests;
  readonly #emit: (event: ToolCancelEvent) => void;
  /** Progress callbacks of the calls still running, by request id. */
  readonly #progress = new Map<string, AgentToolUpdateCallback<unknown>>();

  constructor(requests: HostRequests, emit: (event: ToolCancelEvent) => void) {
    this.#requests = requests;
    this.#emit = emit;
  }

  /** The session's tools for these definitions (omp's `RpcHostToolBridge.setTools`). */
  tools(definitions: readonly CheckedHostTool[]): AgentTool[] {
    return definitions.map((definition) => new HostTool(definition, this));
  }

  /** A running call's progress; false once the call has ended. */
  update(callId: string, partialResult: AgentToolResult<unknown>): boolean {
    const onUpdate = this.#progress.get(callId);
    if (!onUpdate) return false;
    onUpdate(partialResult);
    return true;
  }

  async call(
    name: string,
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ): Promise<AgentToolResult<unknown>> {
    const answer: ToolCallAnswer = await cancellable(
      this.#requests,
      "tool.call",
      { toolCallId, toolName: name, arguments: args },
      signal,
      (requestId) => this.#emit({ type: "tool_cancel", requestId }),
      `Host tool "${name}" was aborted`,
      (requestId) => {
        if (!onUpdate) return () => {};
        this.#progress.set(requestId, onUpdate);
        return () => this.#progress.delete(requestId);
      },
    );
    if (answer.isError) {
      const text = answer.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
      throw new Error(text || "Host tool execution failed");
    }
    return {
      content: answer.content,
      ...(answer.details !== undefined ? { details: answer.details } : {}),
    };
  }
}

/** A host tool as omp's session sees it: the definition's fields, and a call through the server (`RpcHostToolAdapter`). */
class HostTool<TParams extends TSchema = TSchema> implements AgentTool<TParams, unknown> {
  declare name: string;
  declare label: string;
  declare description: string;
  declare parameters: TParams;
  readonly strict = true;
  concurrency: "shared" | "exclusive" = "shared";
  readonly loadMode: ToolLoadMode;
  readonly #tools: HostTools;

  constructor(definition: CheckedHostTool, tools: HostTools) {
    this.#tools = tools;
    applyToolProxy(definition, this);
    this.loadMode = definition.loadMode;
  }

  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ): Promise<AgentToolResult<unknown>> {
    return this.#tools.call(
      this.name,
      toolCallId,
      params as Record<string, unknown>,
      signal,
      onUpdate,
    );
  }
}

/** The app's URI schemes in omp's URL router (omp's `RpcHostUriBridge`). */
export class HostUriSchemes {
  readonly #requests: HostRequests;
  readonly #emit: (event: UriCancelEvent) => void;
  readonly #router: InternalUrlRouter;
  #definitions = new Map<string, HostUriSchemeDefinition>();

  constructor(
    requests: HostRequests,
    emit: (event: UriCancelEvent) => void,
    router: InternalUrlRouter = InternalUrlRouter.instance(),
  ) {
    this.#requests = requests;
    this.#emit = emit;
    this.#router = router;
  }

  /**
   * Replaces the registered schemes, with omp's checks: a scheme is a lower-case URL scheme name, and omp's built-in
   * schemes cannot be taken. Schemes no longer listed leave the router.
   */
  set(schemes: readonly HostUriSchemeDefinition[]): string[] {
    const checked = new Map<string, HostUriSchemeDefinition>();
    for (const raw of schemes) {
      const scheme = raw.scheme.trim().toLowerCase();
      if (!scheme) throw new Error("Host URI scheme must be a non-empty string");
      if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
        throw new Error(`Host URI scheme contains invalid characters: ${raw.scheme}`);
      }
      // A host that shadowed one of omp's schemes would change it for the whole process.
      if (this.#router.isBuiltin(scheme))
        throw new Error(`Host URI scheme is reserved by OMP: ${scheme}://`);
      checked.set(scheme, {
        scheme,
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        writable: raw.writable === true,
        immutable: raw.immutable === true,
      });
    }
    for (const previous of this.#definitions.keys()) {
      if (!checked.has(previous)) this.#router.unregister(previous);
    }
    for (const definition of checked.values())
      this.#router.register(new HostUriHandler(definition, this));
    this.#definitions = checked;
    return [...checked.keys()];
  }

  /** Takes every scheme out of the router, so a later chat in the process does not reach this one's server. */
  clear(): void {
    for (const scheme of this.#definitions.keys()) this.#router.unregister(scheme);
    this.#definitions.clear();
  }

  async read(
    scheme: string,
    url: InternalUrl,
    context?: ResolveContext,
  ): Promise<InternalResource> {
    const answer = await cancellable(
      this.#requests,
      "uri.read",
      { url: url.href },
      context?.signal,
      (requestId) => this.#emit({ type: "uri_cancel", requestId }),
      `Host URI read for ${url.href} was aborted`,
    );
    if (answer.isError)
      throw new Error(answer.error || answer.content || `Host URI read failed for ${url.href}`);
    const content = answer.content ?? "";
    return {
      url: url.href,
      content,
      contentType: answer.contentType ?? "text/plain",
      size: Buffer.byteLength(content, "utf-8"),
      ...(answer.notes && answer.notes.length > 0 ? { notes: [...answer.notes] } : {}),
      immutable: answer.immutable ?? this.#definitions.get(scheme)?.immutable === true,
    };
  }

  async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
    const answer = await cancellable(
      this.#requests,
      "uri.write",
      { url: url.href, content },
      context?.signal,
      (requestId) => this.#emit({ type: "uri_cancel", requestId }),
      `Host URI write for ${url.href} was aborted`,
    );
    if (answer.isError)
      throw new Error(answer.error || answer.content || `Host URI write failed for ${url.href}`);
  }
}

/** One scheme in omp's router; reads, and writes when the scheme is writable (`RpcHostUriProtocolHandler`). */
class HostUriHandler implements ProtocolHandler {
  readonly scheme: string;
  readonly spec: SchemeSpec;
  readonly write?: (url: InternalUrl, content: string, context?: WriteContext) => Promise<void>;
  readonly #schemes: HostUriSchemes;

  constructor(definition: HostUriSchemeDefinition, schemes: HostUriSchemes) {
    this.scheme = definition.scheme;
    this.#schemes = schemes;
    const writable = definition.writable === true;
    this.spec = {
      backing: "remote",
      selectors: "none",
      immutable: definition.immutable === true,
      write: writable
        ? { via: "handler", payload: "text", scope: "workspace", tier: () => "write" }
        : undefined,
    };
    if (writable) this.write = (url, content, context) => schemes.write(url, content, context);
  }

  resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
    return this.#schemes.read(this.scheme, url, context);
  }
}
