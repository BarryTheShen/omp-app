/**
 * omp's card-form session titles: `<icon> <CODE>: <title>` (`🧪 FLAKY: Fix flaky park tests`). omp keeps the card in
 * the title it stores, so the app shows the title's own words and never rewrites the stored title. This mirrors omp
 * 18.12.6's `splitCardTitle` (`packages/coding-agent/src/utils/title-card.ts:171-175`, with the line form at `:43` and
 * the icon rule at `:52-59`). The browser never splits omp's titles: it shows the `displayTitle` this module computes.
 */
const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
/** omp reads at most eight characters as the card's icon. */
const MAX_ICON_CODEPOINTS = 8;

/** Whether `icon` reads as a card icon: one to eight characters, none of them ASCII. */
function isCardIcon(icon: string): boolean {
  let codepoints = 0;
  for (const char of icon) {
    if (char.charCodeAt(0) < 0x80 || ++codepoints > MAX_ICON_CODEPOINTS) return false;
  }
  return codepoints > 0;
}

/** The title's own words: `Fix flaky park tests` for `🧪 FLAKY: Fix flaky park tests`. A title without a card is unchanged. */
export function sessionDisplayTitle(title: string): string {
  const line = CARD_LINE.exec(title);
  if (line === null || !isCardIcon(line[1] ?? "")) return title;
  return line[3] ?? title;
}
