import type { PersistedMessageKey } from "@omp-app/contracts";
import { copyText, type RawTranscriptContent, type RawTranscriptPart } from "@/modules/U1/copy";
import { type TranscriptCopyTargetOption, TranscriptCopyTargetSchema } from "../contract";
import { fencedBlocks, isShellLanguage } from "./fences";
import { exactMarkdownOf, sourceTextOf } from "./text";

export type CopyAuthor = "you" | "omp";

/** A message as the copy picker reads it: U1.7's raw record and, when its role has one, its author. */
export interface CopySourceMessage {
  readonly raw: RawTranscriptContent;
  readonly author?: CopyAuthor;
}

/** Previews are short: the start of a block is enough to tell two targets apart. */
const PREVIEW_LIMIT = 140;

/**
 * Every copy target a chat offers, in transcript order: each message with copyable text, then its
 * commands, code blocks and whole code or output parts. The newest command and the newest code lead the
 * list as shortcuts. Labels number each kind within its message, so every label names one target.
 */
export function buildCopyTargets(
  messages: readonly CopySourceMessage[],
): readonly TranscriptCopyTargetOption[] {
  const options: TranscriptCopyTargetOption[] = [];
  let messageNumber = 0;
  for (const { raw, author } of messages) {
    const parsed = TranscriptCopyTargetSchema.safeParse({
      kind: "message",
      messageKey: raw.messageKey,
    });
    // A streaming message has no persisted key yet, so it is not a copy target.
    if (!parsed.success || exactMarkdownOf(raw.parts).trim() === "") continue;
    messageNumber += 1;
    const from = author === undefined ? "" : ` from ${author}`;
    options.push({
      target: parsed.data,
      label: `Message ${messageNumber}${from}`,
      preview: previewOf(raw),
    });
    options.push(...partOptions(parsed.data.messageKey, raw.parts, messageNumber));
  }
  return withShortcuts(options);
}

function previewOf(raw: RawTranscriptContent): string {
  return collapsed(copyText(raw)) || collapsed(exactMarkdownOf(raw.parts));
}

function partOptions(
  messageKey: PersistedMessageKey,
  parts: readonly RawTranscriptPart[],
  messageNumber: number,
): TranscriptCopyTargetOption[] {
  const options: TranscriptCopyTargetOption[] = [];
  const within = ` in message ${messageNumber}`;
  const counts = { commands: 0, blocks: 0, codes: 0, outputs: 0 };
  let previousType: RawTranscriptPart["type"] | undefined;
  for (const part of parts) {
    if (part.type === "text") {
      for (const block of fencedBlocks(sourceTextOf(part))) {
        if (block.content.trim() === "") continue;
        if (isShellLanguage(block.language)) {
          counts.commands += 1;
          options.push({
            target: { kind: "command", messageKey, partIndex: part.index, blockIndex: block.index },
            label: `Command ${counts.commands}${within}`,
            preview: collapsed(block.content),
          });
        } else {
          counts.blocks += 1;
          options.push({
            target: { kind: "code", messageKey, partIndex: part.index, blockIndex: block.index },
            label: `Code block ${counts.blocks}${within}`,
            preview: collapsed(block.content),
          });
        }
      }
    } else if (
      (part.type === "command" || part.type === "code") &&
      sourceTextOf(part).trim() !== ""
    ) {
      const preview = collapsed(sourceTextOf(part));
      if (part.type === "command") {
        counts.commands += 1;
        options.push({
          target: { kind: "command", messageKey, partIndex: part.index },
          label: `Command ${counts.commands}${within}`,
          preview,
        });
      } else if (previousType === "command" || previousType === "code") {
        // Bash and python output follow the command or code they ran.
        counts.outputs += 1;
        options.push({
          target: { kind: "code", messageKey, partIndex: part.index },
          label: `Output ${counts.outputs}${within}`,
          preview,
        });
      } else {
        counts.codes += 1;
        options.push({
          target: { kind: "code", messageKey, partIndex: part.index },
          label: `Code ${counts.codes}${within}`,
          preview,
        });
      }
    }
    previousType = part.type;
  }
  return options;
}

/** The newest command and the newest code, offered first under fixed labels. */
function withShortcuts(
  options: readonly TranscriptCopyTargetOption[],
): readonly TranscriptCopyTargetOption[] {
  const shortcuts: TranscriptCopyTargetOption[] = [];
  const command = options.findLast((option) => option.target.kind === "command");
  if (command !== undefined) shortcuts.push({ ...command, label: "Latest command" });
  const code = options.findLast((option) => option.target.kind === "code");
  if (code !== undefined) shortcuts.push({ ...code, label: "Latest code" });
  return [...shortcuts, ...options];
}

/** The text as one line, shortened with an ellipsis when it is long. */
function collapsed(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_LIMIT ? flat : `${flat.slice(0, PREVIEW_LIMIT - 1)}…`;
}
