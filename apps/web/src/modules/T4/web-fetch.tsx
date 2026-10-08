import { z } from "zod";
import { type ReadToolDetails, ReadToolDetailsSchema } from "../T1/models";
import type { ToolRegistryDescriptor, ToolRenderer } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { splitToolResult } from "../U3/tool-card/result";
import { T4ReadUrlRenderer } from "./url-read";

const WebFetchArgsSchema = z.looseObject({ url: z.string().optional() });

/**
 * Renders `web_fetch` through T4's URL-read card. omp's result is the page text with no details, so
 * the URL comes from the call's arguments. The browser never fetches the page again.
 */
export const WebFetchRenderer: ToolRenderer = (props) => {
  const state = normalizeToolRendererProps(props);
  const split = splitToolResult(props.result ?? state.result ?? state.partialResult);
  return (
    <div data-slot="t4-web-fetch" data-testid="t4-web-fetch">
      {T4ReadUrlRenderer({
        toolCallId: state.toolCallId,
        rendererProps: props,
        details: webFetchDetails(props.args, split.details),
        rawArgs: state.argsText,
        rawResult: rawText(props.result ?? state.result ?? state.partialResult),
        text: split.text,
      })}
    </div>
  );
};

export const WEB_FETCH_DESCRIPTOR = {
  kind: "tool",
  id: "T4.webFetch",
  owner: "T4",
  title: "Web fetch",
  covers: [],
  requires: [],
  match: { by: "name", name: "web_fetch" },
  renderer: WebFetchRenderer,
} as const satisfies ToolRegistryDescriptor;

function webFetchDetails(args: unknown, details: unknown): ReadToolDetails {
  const parsedDetails = ReadToolDetailsSchema.safeParse(details);
  const source: ReadToolDetails = parsedDetails.success ? parsedDetails.data : {};
  const parsedArgs = WebFetchArgsSchema.safeParse(args);
  const url = source.url ?? (parsedArgs.success ? parsedArgs.data.url : undefined);
  return {
    ...source,
    kind: "url",
    ...(url === undefined ? {} : { url, finalUrl: source.finalUrl ?? url }),
  };
}

/** omp's whole result as JSON: the card's raw view, not a second copy of the page. */
function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return value === undefined ? "" : (JSON.stringify(value, null, 2) ?? "");
  } catch {
    return "[Unserializable web fetch result]";
  }
}
