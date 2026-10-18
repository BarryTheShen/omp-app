/**
 * Typed mirror of `src/styles/tokens.css` (U0 Plan item 2). Colors are exposed as `var()`
 * references so the light/dark source of truth stays in that one CSS file; durations, spacing,
 * easing and z-index are exposed as literal values because JS consumers (a `setTimeout` matched
 * to a CSS transition, Playwright viewport math, a portal's inline `zIndex`) need real numbers
 * or strings, not a reference the DOM alone can resolve. This file and `src/styles/tokens.css`
 * are the only places allowed to hold a raw color, pixel or shadow literal; everywhere else is
 * enforced by `src/styles/raw-values.test.ts` (H4: "icons come only from U0's tokens").
 */
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  Copy,
  ExternalLink,
  GitBranch,
  Info,
  Loader2,
  type LucideIcon,
  Mic,
  Moon,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Sun,
  Trash2,
  X,
} from "lucide-react";

/** Every semantic color a module may use; the value is a CSS `var()` reference, never a literal. */
export const colorTokens = {
  background: "var(--background)",
  foreground: "var(--foreground)",
  card: "var(--card)",
  cardForeground: "var(--card-foreground)",
  popover: "var(--popover)",
  popoverForeground: "var(--popover-foreground)",
  primary: "var(--primary)",
  primaryForeground: "var(--primary-foreground)",
  secondary: "var(--secondary)",
  secondaryForeground: "var(--secondary-foreground)",
  muted: "var(--muted)",
  mutedForeground: "var(--muted-foreground)",
  accent: "var(--accent)",
  accentForeground: "var(--accent-foreground)",
  border: "var(--border)",
  input: "var(--input)",
  ring: "var(--ring)",
  info: "var(--info)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  successSurface: "var(--success-surface)",
  successSurfaceForeground: "var(--success-surface-foreground)",
  warningSurface: "var(--warning-surface)",
  warningSurfaceForeground: "var(--warning-surface-foreground)",
  dangerSurface: "var(--danger-surface)",
  dangerSurfaceForeground: "var(--danger-surface-foreground)",
  infoSurface: "var(--info-surface)",
  infoSurfaceForeground: "var(--info-surface-foreground)",
  diffAdd: "var(--diff-add)",
  diffAddSurface: "var(--diff-add-surface)",
  diffAddForeground: "var(--diff-add-foreground)",
  diffRemove: "var(--diff-remove)",
  diffRemoveSurface: "var(--diff-remove-surface)",
  diffRemoveForeground: "var(--diff-remove-foreground)",
} as const satisfies Record<string, string>;
export type ColorToken = keyof typeof colorTokens;

/** Semantic spacing names over Tailwind's own numeric scale; both stay available to consumers. */
export const spacingTokens = {
  "3xs": "0.125rem",
  "2xs": "0.25rem",
  xs: "0.375rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  "2xl": "2rem",
  "3xl": "3rem",
} as const satisfies Record<string, string>;
export type SpacingToken = keyof typeof spacingTokens;

export const radiusTokens = {
  xs: "var(--radius-xs)",
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  xl: "var(--radius-xl)",
  "2xl": "var(--radius-2xl)",
  "3xl": "var(--radius-3xl)",
  "4xl": "var(--radius-4xl)",
  control: "var(--radius-control)",
  surface: "var(--radius-surface)",
  thread: "var(--radius-thread)",
  document: "var(--radius-document)",
  pill: "var(--radius-pill)",
} as const satisfies Record<string, string>;
export type RadiusToken = keyof typeof radiusTokens;

export const shadowTokens = {
  xs: "var(--shadow-xs)",
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
  lg: "var(--shadow-lg)",
  overlay: "var(--shadow-overlay)",
} as const satisfies Record<string, string>;
export type ShadowToken = keyof typeof shadowTokens;

/** Milliseconds, matching `tokens.css`'s `--duration-*`; respects `prefers-reduced-motion` there. */
export const durationTokens = {
  fast: 120,
  base: 180,
  slow: 260,
  spin: 600,
  loop: 2000,
} as const satisfies Record<string, number>;
export type DurationToken = keyof typeof durationTokens;

export const easingTokens = {
  standard: "cubic-bezier(0.32, 0.72, 0, 1)",
  emphasized: "cubic-bezier(0.23, 1, 0.32, 1)",
} as const satisfies Record<string, string>;
export type EasingToken = keyof typeof easingTokens;

/** Numeric so a consumer can compare/clamp (e.g. `zIndexTokens.modal + 1` for a nested overlay). */
export const zIndexTokens = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  overlay: 1200,
  modal: 1300,
  popover: 1400,
  tooltip: 1500,
  toast: 1600,
} as const satisfies Record<string, number>;
export type ZIndexToken = keyof typeof zIndexTokens;

export const fontTokens = {
  sans: "var(--font-sans)",
  display: "var(--font-display)",
  heading: "var(--font-heading)",
  mono: "var(--font-mono)",
} as const satisfies Record<string, string>;
export type FontToken = keyof typeof fontTokens;

export const typeScaleTokens = {
  meta: { fontSize: "0.6875rem", lineHeight: "1.5" },
  xs: { fontSize: "0.75rem", lineHeight: "1rem" },
  trace: { fontSize: "0.75rem", lineHeight: "1.625" },
  sm: { fontSize: "0.8125rem", lineHeight: "1.5" },
  code: { fontSize: "0.78125rem", lineHeight: "1.625" },
  md: { fontSize: "0.9375rem", lineHeight: "1.5" },
  base: { fontSize: "1rem", lineHeight: "1.5rem" },
  lg: { fontSize: "1.125rem", lineHeight: "1.75rem" },
  xl: { fontSize: "1.25rem", lineHeight: "1.75rem" },
  "2xl": { fontSize: "1.5rem", lineHeight: "2rem" },
} as const satisfies Record<string, { fontSize: string; lineHeight: string }>;
export type TypeScaleToken = keyof typeof typeScaleTokens;

/**
 * The only icons a module should import by name (H4: "icons come only from U0's tokens and
 * components"). Add a new entry here rather than importing directly from `lucide-react`, so
 * every module draws from the same curated set.
 */
export const Icons = {
  send: Send,
  stop: Square,
  copy: Copy,
  check: Check,
  edit: Pencil,
  delete: Trash2,
  close: X,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  loading: Loader2,
  sparkles: Sparkles,
  attachment: Paperclip,
  mic: Mic,
  settings: Settings,
  search: Search,
  add: Plus,
  more: MoreHorizontal,
  lightMode: Sun,
  darkMode: Moon,
  warning: AlertTriangle,
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
  branch: GitBranch,
  undo: RotateCcw,
  pin: Pin,
  externalLink: ExternalLink,
  commandKey: Command,
} as const satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof Icons;
