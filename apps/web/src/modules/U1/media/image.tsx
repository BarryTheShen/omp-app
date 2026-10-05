import { type ImgHTMLAttributes, useState } from "react";
import { cn } from "@/lib/utils";

export interface SafeImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  readonly src?: string;
  readonly fallbackLabel?: string;
}

function isSafeImageSource(src: string | undefined): src is string {
  return (
    src?.startsWith("https://") === true ||
    src?.startsWith("http://") === true ||
    src?.startsWith("data:image/") === true
  );
}

/** Image boundary used by Markdown and message parts; blocked/broken sources stay visible as text. */
export function SafeImage({
  src,
  alt = "Image",
  fallbackLabel = "Image unavailable.",
  className,
  ...props
}: SafeImageProps) {
  const [failed, setFailed] = useState(false);
  if (!isSafeImageSource(src) || failed) {
    return (
      <span
        className={cn(
          "border-border bg-muted/50 text-muted-foreground inline-flex rounded-md border px-3 py-2 text-sm",
          className,
        )}
        data-media-fallback="image"
      >
        {fallbackLabel}
      </span>
    );
  }
  return (
    <img
      {...props}
      alt={alt}
      className={cn("max-h-96 max-w-full rounded-lg object-contain", className)}
      data-media="image"
      src={src}
      onError={() => setFailed(true)}
    />
  );
}

export function FileFallback({
  label = "File unavailable.",
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "border-border bg-muted/50 text-muted-foreground inline-flex rounded-md border px-3 py-2 text-sm",
        className,
      )}
      data-media-fallback="file"
    >
      {label}
    </span>
  );
}
