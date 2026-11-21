import type { ReactNode } from "react";
import { STYLES, setStyle, useStyle } from "./style";

/**
 * Settings → App → Look → Style: how the app is drawn, apart from its colours; a click takes it, and the whole app,
 * this page too, changes at once.
 */
export function StylePicker(): ReactNode {
  const current = useStyle();
  return (
    <div
      role="group"
      aria-label="Style"
      data-tour="style"
      className="grid grid-cols-2 gap-2 py-3 sm:grid-cols-3"
    >
      {STYLES.map((style) => (
        <button
          key={style.id}
          type="button"
          aria-pressed={current === style.id}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left ${current === style.id ? "border-primary bg-raise" : "border-l2 hover:border-l4"}`}
          onClick={() => setStyle(style.id)}
        >
          <span className="text-sm font-medium text-t1" style={{ fontFamily: "var(--sans)" }}>
            {style.name}
          </span>
          <span className="text-xs text-t3" style={{ fontFamily: "var(--prose)" }}>
            {style.words}
          </span>
        </button>
      ))}
    </div>
  );
}
