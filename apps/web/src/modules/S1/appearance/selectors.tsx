import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AppearanceThemeKey } from "./preview";

export type ThemeSelectorProps = {
  readonly settingKey: AppearanceThemeKey;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onPreview: (value: string) => void;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
};
const BUNDLED_THEME_NAMES = ["titanium", "light"] as const;

export function ThemeSelector({
  settingKey,
  value,
  onValueChange,
  onPreview,
  onSelect,
  onCancel,
}: ThemeSelectorProps) {
  const title = settingKey === "theme.dark" ? "Choose dark theme" : "Choose light theme";

  return (
    <section aria-labelledby={`${settingKey}-selector-title`} className="space-y-4">
      <header className="space-y-1">
        <h2 id={`${settingKey}-selector-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-muted-foreground text-sm">
          Preview a bundled browser palette or enter any omp theme name to save it for the terminal.
        </p>
      </header>
      <fieldset className="flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Bundled omp themes</legend>
        {BUNDLED_THEME_NAMES.map((theme) => (
          <Button
            key={theme}
            type="button"
            variant={value === theme ? "default" : "outline"}
            onFocus={() => onPreview(theme)}
            onMouseEnter={() => onPreview(theme)}
            onClick={() => onSelect(theme)}
          >
            {theme === "titanium" ? "Titanium (dark)" : "Light"}
          </Button>
        ))}
      </fieldset>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${settingKey}-custom-theme`}>
          omp theme name
        </label>
        <Input
          id={`${settingKey}-custom-theme`}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            if (event.target.value.trim()) onPreview(event.target.value);
          }}
          onFocus={() => {
            if (value.trim()) onPreview(value);
          }}
          placeholder="Theme name"
        />
      </div>
      <footer className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={!value.trim()} onClick={() => onSelect(value)}>
          Use this theme name
        </Button>
      </footer>
    </section>
  );
}

export type ShowImagesSelectorProps = {
  readonly value: boolean;
  readonly onPreview: (value: boolean) => void;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
};

export function ShowImagesSelector({
  value,
  onPreview,
  onSelect,
  onCancel,
}: ShowImagesSelectorProps) {
  return (
    <section aria-labelledby="show-images-selector-title" className="space-y-4">
      <header className="space-y-1">
        <h2 id="show-images-selector-title" className="text-lg font-semibold">
          Show images
        </h2>
        <p className="text-muted-foreground text-sm">
          Choose inline image rendering or text placeholders.
        </p>
      </header>
      <fieldset className="flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Show inline images</legend>
        <Button
          type="button"
          variant={value ? "default" : "outline"}
          aria-pressed={value}
          onFocus={() => onPreview(true)}
          onMouseEnter={() => onPreview(true)}
          onClick={() => onSelect(true)}
        >
          Yes
        </Button>
        <Button
          type="button"
          variant={!value ? "default" : "outline"}
          aria-pressed={!value}
          onFocus={() => onPreview(false)}
          onMouseEnter={() => onPreview(false)}
          onClick={() => onSelect(false)}
        >
          No
        </Button>
      </fieldset>
      <footer className="flex justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </footer>
    </section>
  );
}
