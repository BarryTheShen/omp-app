import { ComposerPrimitive } from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, CapabilityStatus, FolderPath } from "@omp-app/contracts";
import { type ReactNode, useMemo } from "react";
import type { MentionProvider } from "@/modules/D2/contract";
import {
  createEmojiProvider,
  createInternalUrlProvider,
  LocalComposerSlot,
  type LocalProvider,
} from "@/modules/D2/local";
import {
  createFileMentionProvider,
  createGithubMentionProvider,
  MentionComposerSlot,
} from "@/modules/D2/mentions";
import { type SlashCommandProvider, SlashComposerSlot } from "@/modules/D2/slash";

export interface ComposerTriggerProviders {
  readonly mention: readonly MentionProvider[];
  readonly local: readonly LocalProvider[];
}

export interface ComposerTriggersProps {
  readonly client: AppClient;
  /** The folder the open chat belongs to; file and GitHub lookups need it. */
  readonly folder: FolderPath | null;
  readonly capabilities: CapabilityMap;
  /** The open chat's slash-command provider; `/` opens its command list when present. */
  readonly slash?: SlashCommandProvider | null | undefined;
  readonly children: ReactNode;
}

/** An available capability, or one that works through a fallback path. */
function usable(status: CapabilityStatus | undefined): boolean {
  return status?.state === "available" || status?.state === "fallback";
}

/**
 * The providers the open chat's composer offers. A trigger whose capability is missing is left out
 * entirely. A provider whose search reports itself unavailable stays in: D2 keeps that trigger's
 * list closed, so the character types as plain text and no list or message appears.
 */
export function composerTriggerProviders({
  client,
  folder,
  capabilities,
}: Pick<ComposerTriggersProps, "client" | "folder" | "capabilities">): ComposerTriggerProviders {
  const github =
    folder && usable(capabilities["host.github-refs"])
      ? createGithubMentionProvider({ client, folder })
      : undefined;
  const mention: MentionProvider[] = [];
  if (folder && usable(capabilities["host.file-search"])) {
    mention.push(createFileMentionProvider({ client, folder }));
  }
  if (github) mention.push(github);
  const local: LocalProvider[] = [createEmojiProvider()];
  if (usable(capabilities["host.url-catalog"])) {
    local.push(createInternalUrlProvider({ client, githubProvider: github }));
  }
  return { mention, local };
}

/** assistant-ui writes the chosen text into the draft; the composer needs nothing more from it. */
function keepInsertedText(): void {}

/**
 * Wraps the composer in D2's trigger slots: `/` omp commands and app commands (slash), `@` files and `#`
 * GitHub references (mentions), `:` emoji and scheme links such as `issue://` (local). All of them share one
 * trigger root, so the composer's textarea can point at whichever list is open. The caret, keyboard and Escape
 * behavior belong to the slots; this file only chooses which providers the open chat gets.
 */
export function ComposerTriggers({
  client,
  folder,
  capabilities,
  slash,
  children,
}: ComposerTriggersProps) {
  const providers = useMemo(
    () => composerTriggerProviders({ client, folder, capabilities }),
    [client, folder, capabilities],
  );
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <LocalComposerSlot onSelect={keepInsertedText} providers={providers.local}>
        <MentionComposerSlot onSelect={keepInsertedText} providers={providers.mention}>
          <SlashComposerSlot onSelect={keepInsertedText} providers={slash ? [slash] : []}>
            {children}
          </SlashComposerSlot>
        </MentionComposerSlot>
      </LocalComposerSlot>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
