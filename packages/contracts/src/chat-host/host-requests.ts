/**
 * The requests a host sends the server (SDK plan H5.2d, H5.2e): its dialogs, and the calls of the app's tools and URI
 * schemes. The server answers each with one response; the host checks each answer before omp sees it.
 */
import type { z } from "zod";
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
