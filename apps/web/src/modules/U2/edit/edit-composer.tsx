import {
  type AssistantClient,
  AssistantRuntimeProvider,
  type ThreadMessage,
  useAui,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "../../../components/ui/button";
import { ComposerSurface } from "../composer/composer";
import type { PromptIntent, SubmitPolicy } from "../contract";
import {
  createEditComposerHooks,
  type EditComposerHookOptions,
  type EditComposerHooks,
  type EditComposerReplacementRequest,
  type EditComposerSource,
} from "./hooks";

export type {
  EditComposerHookOptions,
  EditComposerHooks,
  EditComposerReplacement,
  EditComposerReplacementRequest,
  EditComposerSnapshot,
  EditComposerSource,
} from "./hooks";

export interface EditComposerProps {
  readonly source: EditComposerSource;
  readonly submitReplacement: EditComposerHookOptions["onSubmitReplacement"];
  readonly onCancel: () => void;
  readonly policy?: SubmitPolicy;
  readonly autoFocus?: boolean;
}

function imageAttachment(
  image: unknown,
  index: number,
):
  | {
      readonly id: string;
      readonly type: "image";
      readonly name: string;
      readonly contentType: string;
      readonly content: [{ readonly type: "image"; readonly image: string }];
    }
  | undefined {
  if (typeof image !== "object" || image === null || Array.isArray(image)) return undefined;
  const record = image as Record<string, unknown>;
  if (record.type !== "image") return undefined;
  const mediaType = typeof record.mimeType === "string" ? record.mimeType : "image/*";
  const source =
    typeof record.image === "string"
      ? record.image
      : typeof record.data === "string"
        ? `data:${mediaType};base64,${record.data}`
        : undefined;
  if (!source) return undefined;
  return {
    id: `edit-image-${index}`,
    type: "image",
    name: `Image ${index + 1}`,
    contentType: mediaType,
    content: [{ type: "image", image: source }],
  };
}

async function loadComposerDraft(
  composer: AssistantClient["composer"],
  source: EditComposerSource,
): Promise<void> {
  composer.setText(source.text);
  await composer.clearAttachments();
  for (const [index, image] of source.images.entries()) {
    const attachment = imageAttachment(image, index);
    if (attachment) await composer.addAttachment(attachment);
  }
  for (const ref of source.attachmentRefs) {
    await composer.addAttachment({
      id: ref.id,
      type: "file",
      name: ref.name,
      contentType: ref.mediaType,
      content: [{ type: "file", data: ref.uri ?? ref.id, mimeType: ref.mediaType }],
    });
  }
}

interface EditComposerBodyProps {
  readonly source: EditComposerSource;
  readonly policy?: SubmitPolicy;
  readonly autoFocus?: boolean;
  readonly composer: AssistantClient["composer"];
  readonly hooks: EditComposerHooks;
}

function EditComposerBody({ source, policy, autoFocus, composer, hooks }: EditComposerBodyProps) {
  const sourceMessageId = source.sourceMessageId;
  const sourceRef = useRef(source);
  if (sourceRef.current.sourceMessageId !== sourceMessageId) {
    sourceRef.current = source;
  }
  const handleCancel = useCallback(() => {
    const wasEditing = hooks.snapshot().isEditing;
    hooks.cancel();
    if (wasEditing) void loadComposerDraft(composer, hooks.snapshot());
  }, [composer, hooks]);
  useEffect(() => {
    const loadedSource = sourceRef.current;
    if (loadedSource.sourceMessageId !== sourceMessageId) return;
    hooks.load(loadedSource);
    void loadComposerDraft(composer, loadedSource);
  }, [composer, hooks, sourceMessageId]);

  const submitPrompt = useCallback(
    async (intent: PromptIntent): Promise<void> => {
      const replacement: EditComposerReplacementRequest = {
        text: intent.text,
        images: intent.images ?? [],
        attachmentRefs: intent.attachmentRefs ?? [],
        sourceMessageId: source.sourceMessageId,
      };
      await hooks.submitReplacement(replacement);
    },
    [hooks, source.sourceMessageId],
  );

  const handleKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
      }
    },
    [handleCancel],
  );

  return (
    <div data-slot="u2-edit-composer" onKeyDownCapture={handleKeyDownCapture}>
      <ComposerSurface
        submitPrompt={submitPrompt}
        cancel={handleCancel}
        policy={policy}
        autoFocus={autoFocus}
      >
        <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
          Cancel edit
        </Button>
      </ComposerSurface>
    </div>
  );
}

/** Reuses U2.2's composer surface inside an isolated edit composer runtime. */
export function EditComposer({
  source,
  submitReplacement,
  onCancel,
  policy,
  autoFocus = true,
}: EditComposerProps) {
  const hooks = useRef<EditComposerHooks | null>(null);
  if (hooks.current === null) {
    hooks.current = createEditComposerHooks({
      onSubmitReplacement: submitReplacement,
      onCancel,
    });
  }
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <EditComposerRuntimeBody
        source={source}
        policy={policy}
        autoFocus={autoFocus}
        hooks={hooks.current}
      />
    </AssistantRuntimeProvider>
  );
}

function EditComposerRuntimeBody(props: Omit<EditComposerBodyProps, "composer">) {
  const composer = useAui().composer;
  return <EditComposerBody {...props} composer={composer} />;
}
