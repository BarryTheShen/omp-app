/**
 * The requests a host sends the server (SDK plan H5.2d, H5.2e): its dialogs, and the calls of the app's tools and URI
 * schemes. The server answers each with one response; the host checks each answer before omp sees it.
 */
import { z } from "zod";
import {
  ApproveAnswer,
  type ApproveDialog,
  AskAnswer,
  type AskDialog,
  ConfirmAnswer,
  type ConfirmDialog,
  type EditorDialog,
  type InputDialog,
  type SelectDialog,
  ValueAnswer,
} from "./dialogs";
import {
  ToolCallAnswer,
  type ToolCallRequest,
  UriReadAnswer,
  type UriReadRequest,
  UriWriteAnswer,
  type UriWriteRequest,
} from "./host-tools";

export interface ChatHostHostMethodMap {
  readonly "ui.select": { readonly params: SelectDialog; readonly result: ValueAnswer };
  readonly "ui.confirm": { readonly params: ConfirmDialog; readonly result: ConfirmAnswer };
  readonly "ui.input": { readonly params: InputDialog; readonly result: ValueAnswer };
  readonly "ui.editor": { readonly params: EditorDialog; readonly result: ValueAnswer };
  /** Sent only after the server turned the ask dialog on (`set_ask_dialog`). */
  readonly "ui.ask": { readonly params: AskDialog; readonly result: AskAnswer };
  readonly "ui.approve": { readonly params: ApproveDialog; readonly result: ApproveAnswer };
  readonly "tool.call": { readonly params: ToolCallRequest; readonly result: ToolCallAnswer };
  readonly "uri.read": { readonly params: UriReadRequest; readonly result: UriReadAnswer };
  readonly "uri.write": { readonly params: UriWriteRequest; readonly result: UriWriteAnswer };
}
export type ChatHostHostMethod = keyof ChatHostHostMethodMap;

/** A request from the host, with its method's params. */
export type HostRequest = {
  readonly [M in ChatHostHostMethod]: {
    readonly id: string;
    readonly method: M;
    readonly params: ChatHostHostMethodMap[M]["params"];
  };
}[ChatHostHostMethod];

/** The host's dialogs: the requests a person answers (`ui.*`), as against the calls of the app's tools and URIs. */
export type HostDialogMethod = Extract<ChatHostHostMethod, `ui.${string}`>;
export type HostDialogRequest = Extract<HostRequest, { readonly method: HostDialogMethod }>;

/** Whether a host request is one of its dialogs. */
export function isHostDialogRequest(request: HostRequest): request is HostDialogRequest {
  return request.method.startsWith("ui.");
}

/** The host's calls of the app's tools (`tool.call`) and of its URI schemes (`uri.read`, `uri.write`). */
export type HostToolCall = Extract<HostRequest, { readonly method: "tool.call" }>;
export type HostUriCall = Extract<HostRequest, { readonly method: "uri.read" | "uri.write" }>;

export function isHostToolCall(request: HostRequest): request is HostToolCall {
  return request.method === "tool.call";
}

export function isHostUriCall(request: HostRequest): request is HostUriCall {
  return request.method === "uri.read" || request.method === "uri.write";
}

/** A dialog's answer, in the host's shape for its method. */
export type HostDialogAnswer<M extends HostDialogMethod = HostDialogMethod> =
  ChatHostHostMethodMap[M]["result"];

/** A host request's envelope, as the server's chat session port carries it; the host built its params. */
export const HostRequestSchema = z.custom<HostRequest>(
  (value) => {
    if (typeof value !== "object" || value === null) return false;
    const { id, method } = value as { id?: unknown; method?: unknown };
    return (
      typeof id === "string" &&
      id.length > 0 &&
      typeof method === "string" &&
      isChatHostHostMethod(method)
    );
  },
  { message: "expected a chat host's request" },
);

/** Checks each answer the server sends before omp sees it. */
export const HOST_METHOD_ANSWERS: {
  readonly [M in ChatHostHostMethod]: z.ZodType<ChatHostHostMethodMap[M]["result"]>;
} = {
  "ui.select": ValueAnswer,
  "ui.confirm": ConfirmAnswer,
  "ui.input": ValueAnswer,
  "ui.editor": ValueAnswer,
  "ui.ask": AskAnswer,
  "ui.approve": ApproveAnswer,
  "tool.call": ToolCallAnswer,
  "uri.read": UriReadAnswer,
  "uri.write": UriWriteAnswer,
};

/** Whether a host's request names one of the host's methods; never an object's inherited names. */
export function isChatHostHostMethod(method: string): method is ChatHostHostMethod {
  return Object.hasOwn(HOST_METHOD_ANSWERS, method);
}
