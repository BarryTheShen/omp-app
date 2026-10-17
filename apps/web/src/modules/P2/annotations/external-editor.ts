export const ANNOTATION_EXTERNAL_EDITOR_CAPABILITY = "host.external-editor" as const;

export interface AnnotationExternalEditor {
  readonly open: (text: string, options?: { readonly signal?: AbortSignal }) => Promise<string>;
}

export type ExternalEditorAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export function externalEditorAvailability(
  editor: AnnotationExternalEditor | undefined,
): ExternalEditorAvailability {
  return editor === undefined
    ? { available: false, reason: "An external editor is not available in this host." }
    : { available: true };
}

export async function refineInExternalEditor(
  editor: AnnotationExternalEditor | undefined,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  if (editor === undefined) throw new Error("An external editor is not available in this host.");
  return editor.open(text, { signal });
}
