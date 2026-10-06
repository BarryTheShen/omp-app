import { APP_COMPOSER_PREVIEW_NOTE, APP_THEME_PREVIEW_NOTE } from "./descriptors";

export type BrowserPalette = "light" | "dark";
export type AppearanceThemeKey = "theme.dark" | "theme.light";

export type ThemePreviewResult = {
  readonly palette: BrowserPalette;
  readonly note?: string;
};

/** The browser knows U0's two bundled palettes, not arbitrary OMP theme files. */
export function previewOmpTheme(key: AppearanceThemeKey, themeName: string): ThemePreviewResult {
  if (themeName === "titanium") return { palette: "dark" };
  if (themeName === "light") return { palette: "light" };
  return {
    palette: key === "theme.dark" ? "dark" : "light",
    note: APP_THEME_PREVIEW_NOTE,
  };
}

/** Extension composer shapes can be saved, but only omp can render shapes not bundled by this app. */
export function composerPreviewNote(shape: string): string | undefined {
  return ["band", "box"].includes(shape) ? undefined : APP_COMPOSER_PREVIEW_NOTE;
}

export type AppearancePreviewModel = {
  readonly palette: BrowserPalette;
  readonly themeNote?: string;
  readonly composerShape: string;
  readonly composerNote?: string;
  readonly statusLinePreset: string;
  readonly statusLineSeparator: string;
  readonly contextLine: string;
  readonly hideToolActivity: boolean;
  readonly showTokenUsage: boolean;
  readonly showTurnTime: boolean;
  readonly showCacheMissMarker: boolean;
  readonly showCompactedHistory: boolean;
  readonly showImages: boolean;
};

export function AppearancePreview({ model }: { readonly model: AppearancePreviewModel }) {
  return (
    <aside
      aria-label="Appearance preview"
      className="bg-card text-card-foreground space-y-3 rounded-xl border p-4"
      data-appearance-preview
      data-palette={model.palette}
    >
      <header>
        <h2 className="font-semibold">Preview</h2>
        {model.themeNote ? (
          <p className="text-muted-foreground mt-1 text-sm">{model.themeNote}</p>
        ) : null}
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <section className="bg-muted rounded-lg p-3" aria-label="Composer and status preview">
          <p className="text-muted-foreground text-xs">Composer · {model.composerShape}</p>
          {model.composerNote ? (
            <p className="text-muted-foreground text-xs">{model.composerNote}</p>
          ) : null}
          <div className="mt-2 rounded-lg border bg-background p-3 text-sm">
            Ask omp to inspect this change
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            {model.statusLinePreset} · {model.statusLineSeparator} · context {model.contextLine}
          </p>
        </section>
        <section className="bg-muted space-y-2 rounded-lg p-3" aria-label="Transcript preview">
          <p className="text-muted-foreground text-xs">Transcript</p>
          {!model.hideToolActivity ? (
            <p className="rounded-md border bg-background px-3 py-2 text-sm">Tool activity</p>
          ) : null}
          <p className="rounded-md border bg-background px-3 py-2 text-sm">
            The assistant response remains readable in either theme.
          </p>
          {model.showTokenUsage ? (
            <span className="text-muted-foreground text-xs">128 tokens</span>
          ) : null}
          {model.showTurnTime ? (
            <span className="text-muted-foreground ml-2 text-xs">2.4s</span>
          ) : null}
          {model.showCacheMissMarker ? (
            <p className="border-border border-t pt-2 text-xs">Cache miss</p>
          ) : null}
          {model.showCompactedHistory ? (
            <p className="text-muted-foreground text-xs">Compacted history summary</p>
          ) : null}
        </section>
      </div>
      <section className="bg-muted rounded-lg p-3" aria-label="Image preview">
        <p className="text-muted-foreground mb-2 text-xs">Image display</p>
        {model.showImages ? (
          <div
            aria-label="Inline image preview"
            className="bg-background flex max-h-40 items-center gap-3 overflow-hidden rounded-lg border p-3 text-sm"
            role="img"
          >
            <span className="bg-primary/10 border-primary/20 text-primary flex size-16 shrink-0 items-center justify-center rounded-md border">
              <svg
                aria-hidden="true"
                className="size-8 max-h-40 max-w-full object-contain"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                viewBox="0 0 24 24"
              >
                <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m4.5 16 4-4 3 3 3.5-4 4.5 5" />
              </svg>
            </span>
            <span className="text-muted-foreground">Sample image</span>
          </div>
        ) : (
          <p className="text-muted-foreground rounded-lg border bg-background px-3 py-4 text-sm">
            Image placeholder
          </p>
        )}
      </section>
    </aside>
  );
}
