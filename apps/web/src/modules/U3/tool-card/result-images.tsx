import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { RESULT_IMAGE_MAX_BYTES, type ResultImagePreview } from "./result-image";

/**
 * The pictures a tool result holds. Each one that can be drawn is shown in a bounded box; each one
 * that cannot says why, in the same words in every card. `resultImagePreviews` checks them first.
 */
export function ResultImages({
  alt,
  caption,
  previews,
}: {
  readonly alt: string;
  /** omp's text for the result, shown under the pictures. */
  readonly caption?: string;
  readonly previews: readonly ResultImagePreview[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-slot="tool-result-images">
      {previews.map((preview, index) => {
        const key = `${index}:${preview.kind}`;
        return preview.kind === "shown" ? (
          <ResultImageView alt={alt} key={key} src={preview.src} />
        ) : (
          <p
            className="border-border bg-muted/40 rounded-lg border p-3 text-sm text-muted-foreground"
            data-slot="tool-result-image-note"
            key={key}
          >
            {resultImageNote(preview)}
          </p>
        );
      })}
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  );
}

/** One picture in a bounded box; the button shows it at its own size, scrolling inside the card. */
function ResultImageView({ alt, src }: { readonly alt: string; readonly src: string }) {
  const [fullSize, setFullSize] = useState(false);
  return (
    <figure
      className="border-border bg-muted/30 flex min-w-0 flex-col items-center gap-2 rounded-lg border p-3"
      data-slot="tool-result-image"
    >
      <div className={fullSize ? "max-w-full overflow-auto" : "flex max-w-full justify-center"}>
        <img
          alt={alt}
          className={fullSize ? "max-w-none" : "max-h-64 max-w-full object-contain"}
          src={src}
        />
      </div>
      <Button
        aria-expanded={fullSize}
        onClick={() => setFullSize((open) => !open)}
        size="sm"
        type="button"
        variant="outline"
      >
        {fullSize ? "Show smaller" : "Show full size"}
      </Button>
    </figure>
  );
}

function resultImageNote(preview: Exclude<ResultImagePreview, { readonly kind: "shown" }>): string {
  switch (preview.kind) {
    case "too-large":
      return `This image is ${(preview.bytes / (1024 * 1024)).toFixed(1)} MB. This card shows images up to ${RESULT_IMAGE_MAX_BYTES / (1024 * 1024)} MB, so it is not drawn here.`;
    case "not-loaded":
      return `This image is not in the saved chat: it is over the ${RESULT_IMAGE_MAX_BYTES / (1024 * 1024)} MB this card shows, or its saved copy is missing.`;
    case "unsupported":
      return "This type of image cannot be shown here.";
    case "unreadable":
      return "This image could not be shown: omp's result does not hold readable picture data.";
  }
}
