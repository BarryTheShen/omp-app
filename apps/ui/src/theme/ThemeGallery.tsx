import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { pickTheme, THEMES, type ThemeInfo, useSystemThemes, useThemeChoice } from "./theme";

/**
 * Every theme as a small picture of the app in its own colours (each card is a `data-theme` of its own), your dark
 * themes and your light themes apart. A click keeps one as your theme for its mode (the switch's Light or Dark, and
 * what "Match the system" uses then). Pointing at a card changes nothing: drawing the whole app in another theme
 * restyles every open chat, too slow to do for each card the pointer passes.
 */
export function ThemeGallery(): ReactNode {
  const choice = useThemeChoice();
  const kept = useSystemThemes();
  return (
    <div data-tour="theme-gallery" className="flex flex-col gap-5">
      {(["dark", "light"] as const).map((mode) => (
        <section key={mode} aria-label={mode === "dark" ? "Dark themes" : "Light themes"}>
          <h4 className="mb-2 text-xs font-medium text-t3">
            {mode === "dark" ? "Dark themes" : "Light themes"}
          </h4>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
            {THEMES.filter((theme) => theme.mode === mode).map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                chosen={kept[mode].id === theme.id}
                shown={choice === theme.id}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ThemeCard({
  theme,
  chosen,
  shown,
}: {
  readonly theme: ThemeInfo;
  /** Your theme for its mode. */
  readonly chosen: boolean;
  /** The one the app always shows (not following the system). */
  readonly shown: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      data-theme={theme.id}
      aria-pressed={chosen}
      aria-label={chosen ? `${theme.name}, your ${theme.mode} theme` : theme.name}
      className="group flex flex-col overflow-hidden rounded-xl border border-l3 bg-panel text-left outline-none transition-shadow hover:border-l4 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-ring aria-pressed:ring-2 aria-pressed:ring-ring"
      onClick={() => pickTheme(theme.id)}
    >
      <ThemePicture />
      <span className="flex min-w-0 items-center gap-1.5 border-t border-l2 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-t1">{theme.name}</span>
        {(chosen || shown) && (
          <Check aria-hidden="true" className="size-3.5 shrink-0 text-accent-ink" />
        )}
      </span>
    </button>
  );
}

/**
 * The app in miniature, drawn in the card's theme: the page with the chat list, a pane with a reply, a line of code in
 * the theme's code colours, the status colours, and the box.
 */
function ThemePicture(): ReactNode {
  return (
    <span aria-hidden="true" className="flex h-20 gap-1.5 bg-page p-1.5">
      <span className="flex w-[22%] flex-col gap-1 pt-1">
        <span className="h-1.5 w-full rounded-full bg-l3" />
        <span className="h-1.5 w-4/5 rounded-full bg-l4" />
        <span className="h-1.5 w-full rounded-full bg-l3" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-panel p-1.5">
        <span className="h-1.5 w-3/4 rounded-full bg-t1" />
        <span className="flex gap-1">
          <span className="h-1.5 w-2.5 rounded-full bg-(--syn-keyword)" />
          <span className="h-1.5 w-5 rounded-full bg-(--syn-string)" />
          <span className="h-1.5 w-3.5 rounded-full bg-(--syn-function)" />
        </span>
        <span className="flex gap-1 pt-0.5">
          <span className="size-1.5 rounded-full bg-ok" />
          <span className="size-1.5 rounded-full bg-warn" />
          <span className="size-1.5 rounded-full bg-bad" />
          <span className="size-1.5 rounded-full bg-live" />
        </span>
        <span className="mt-auto flex items-center gap-1 rounded-sm border border-l2 bg-card px-1 py-0.5">
          <span className="h-1 flex-1 rounded-full bg-t4" />
          <span className="size-2.5 rounded-sm bg-primary" />
        </span>
      </span>
    </span>
  );
}
