import type { ComposerTriggerProvider } from "../../U2/contract";
import type { TriggerKind, TriggerSearchResult, TriggerSource } from "../contract";

export type LocalTrigger = ":" | `${string}://`;

export interface LocalProvider extends Omit<ComposerTriggerProvider, "trigger" | "search"> {
  readonly trigger: LocalTrigger;
  readonly kind: Extract<TriggerKind, "emoji" | "internal-url">;
  readonly source: Extract<TriggerSource, "client" | "a1.url-catalog">;
  readonly search: ComposerTriggerProvider["search"];
  readonly searchTyped: (
    query: string,
    position?: import("../contract").TriggerPosition,
  ) => TriggerSearchResult | Promise<TriggerSearchResult>;
}
