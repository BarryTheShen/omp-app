/** What the panel's page (`webview.ts`) and the extension (`panel.ts`) say to each other. */
import type { EmbedFiles, HostContext } from "@omp-app/contracts";

/** What the extension puts in the panel's page. */
export interface PanelConfig {
  /** omp app's origin. */
  readonly app: string;
  /** The open folder, as the panel tells the app (`files` of the hello); null with no folder open. */
  readonly files: EmbedFiles | null;
  /** The chat to reopen; null for a new one. */
  readonly chat: string | null;
  /** The open file and selection when the panel opens. */
  readonly context: HostContext | null;
}

/** A question of the page to the extension. */
export type Question =
  | { readonly what: "key" }
  | { readonly what: "keep-key"; readonly key: string }
  | { readonly what: "chat"; readonly chat: string }
  | { readonly what: "tool"; readonly name: string; readonly args: Record<string, unknown> };

export type ToExtension =
  | ({ readonly type: "ask"; readonly id: number } & Question)
  /** The page no longer wants an answer (omp gave the tool's call up). */
  | { readonly type: "give-up"; readonly id: number }
  /** A note's buttons: open the address setting, or load the panel again. */
  | { readonly type: "settings" }
  | { readonly type: "retry" }
  /** The app's page never said it listens in the panel (`onNoAnswer`). */
  | { readonly type: "no-answer" };

export type FromExtension =
  | {
      readonly ompAppExtension: 1;
      readonly type: "answer";
      readonly id: number;
      readonly value?: unknown;
      readonly error?: string;
    }
  | { readonly ompAppExtension: 1; readonly type: "context"; readonly context: HostContext | null };
