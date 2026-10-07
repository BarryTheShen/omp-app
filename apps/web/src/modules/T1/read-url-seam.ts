import type { ToolCallId } from "@omp-app/contracts";
import type { ReactNode } from "react";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import type { ReadToolDetails } from "./models";

/** Data T4 receives when a normalized read detail is an internal URL. */
export interface ReadUrlRendererProps {
  readonly toolCallId: ToolCallId;
  readonly rendererProps: ToolRendererProps;
  readonly details: ReadToolDetails;
  readonly rawArgs: string;
  readonly rawResult: string;
  /** The text omp returned for the read ("" when there is none): a URL read's page is here, not in `details`. */
  readonly text: string;
}

/** T4 implements this type in its own module; T1 never imports T4 or fetches the URL. */
export type ReadUrlRenderer = (props: ReadUrlRendererProps) => ReactNode;

/** Dispatches only URL-shaped read details; ordinary file reads stay in T1. */
export function dispatchReadUrl(
  props: ReadUrlRendererProps,
  renderer: ReadUrlRenderer | undefined,
): ReactNode | null {
  if (props.details.kind !== "url" || renderer === undefined) return null;
  return renderer(props);
}
