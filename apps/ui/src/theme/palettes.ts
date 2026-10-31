/**
 * The palette themes: each one's own colours, read from its project's files (the file is named with each theme), mapped
 * onto the app's surfaces, text levels and status colours. `derive.ts` keeps every text readable: where a palette colour
 * misses a contrast check (`styles/themes.test.ts`), its shade moves in lightness only, keeping its hue. `bun run themes`
 * writes the result into `styles/themes.css`.
 */

/** A palette's colours in the app's roles. */
export interface PaletteColors {
  /** The page behind the panes (the frame, the chat list). */
  readonly page: string;
  /** A pane's own background. */
  readonly panel: string;
  /** Cards, the message box. */
  readonly card: string;
  /** Raised controls (secondary buttons). */
  readonly raise: string;
  readonly codeBg: string;
  readonly tblHead: string;
  /** Menus and popovers. */
  readonly popBg: string;
  /** Text, from the strongest to the faintest. */
  readonly t1: string;
  readonly t2: string;
  readonly t3: string;
  readonly t4: string;
  readonly accent: string;
  readonly ok: string;
  readonly warn: string;
  readonly bad: string;
  /** Something running. */
  readonly live: string;
  /** Annotations. */
  readonly inkPen: string;
}

export interface Palette {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly mode: "dark" | "light";
  /** The file the colours were read from. */
  readonly source: string;
  readonly colors: PaletteColors;
}

const CATPPUCCIN = "https://github.com/catppuccin/palette/blob/main/palette.json (v1.8.0, MIT)";
const TOKYO_NIGHT =
  "https://github.com/tokyo-night/tokyo-night-vscode-theme/tree/master/themes (MIT)";

export const PALETTES: readonly Palette[] = [
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    family: "Catppuccin",
    mode: "light",
    source: CATPPUCCIN,
    colors: {
      page: "#e6e9ef",
      panel: "#eff1f5",
      card: "#eff1f5",
      raise: "#e6e9ef",
      codeBg: "#e6e9ef",
      tblHead: "#e6e9ef",
      popBg: "#eff1f5",
      t1: "#4c4f69",
      t2: "#5c5f77",
      t3: "#6c6f85",
      t4: "#9ca0b0",
      accent: "#1e66f5",
      ok: "#40a02b",
      warn: "#df8e1d",
      bad: "#d20f39",
      live: "#8839ef",
      inkPen: "#fe640b",
    },
  },
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappé",
    family: "Catppuccin",
    mode: "dark",
    source: CATPPUCCIN,
    colors: {
      page: "#292c3c",
      panel: "#303446",
      card: "#414559",
      raise: "#414559",
      codeBg: "#232634",
      tblHead: "#292c3c",
      popBg: "#414559",
      t1: "#c6d0f5",
      t2: "#b5bfe2",
      t3: "#a5adce",
      t4: "#737994",
      accent: "#8caaee",
      ok: "#a6d189",
      warn: "#e5c890",
      bad: "#e78284",
      live: "#ca9ee6",
      inkPen: "#ef9f76",
    },
  },
  {
    id: "catppuccin-macchiato",
    name: "Catppuccin Macchiato",
    family: "Catppuccin",
    mode: "dark",
    source: CATPPUCCIN,
    colors: {
      page: "#1e2030",
      panel: "#24273a",
      card: "#363a4f",
      raise: "#363a4f",
      codeBg: "#181926",
      tblHead: "#1e2030",
      popBg: "#363a4f",
      t1: "#cad3f5",
      t2: "#b8c0e0",
      t3: "#a5adcb",
      t4: "#6e738d",
      accent: "#8aadf4",
      ok: "#a6da95",
      warn: "#eed49f",
      bad: "#ed8796",
      live: "#c6a0f6",
      inkPen: "#f5a97f",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    family: "Catppuccin",
    mode: "dark",
    source: CATPPUCCIN,
    colors: {
      page: "#181825",
      panel: "#1e1e2e",
      card: "#313244",
      raise: "#313244",
      codeBg: "#11111b",
      tblHead: "#181825",
      popBg: "#313244",
      t1: "#cdd6f4",
      t2: "#bac2de",
      t3: "#a6adc8",
      t4: "#6c7086",
      accent: "#89b4fa",
      ok: "#a6e3a1",
      warn: "#f9e2af",
      bad: "#f38ba8",
      live: "#cba6f7",
      inkPen: "#fab387",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    family: "Tokyo Night",
    mode: "dark",
    source: `${TOKYO_NIGHT}, tokyo-night-color-theme.json`,
    colors: {
      page: "#16161e",
      panel: "#1a1b26",
      card: "#1e202e",
      raise: "#202330",
      codeBg: "#14141b",
      tblHead: "#16161e",
      popBg: "#202330",
      t1: "#a9b1d6",
      t2: "#787c99",
      t3: "#515670",
      t4: "#363b54",
      accent: "#7aa2f7",
      ok: "#9ece6a",
      warn: "#e0af68",
      bad: "#f7768e",
      live: "#bb9af7",
      inkPen: "#ff9e64",
    },
  },
  {
    id: "tokyo-night-storm",
    name: "Tokyo Night Storm",
    family: "Tokyo Night",
    mode: "dark",
    source: `${TOKYO_NIGHT}, tokyo-night-storm-color-theme.json`,
    colors: {
      page: "#1f2335",
      panel: "#24283b",
      card: "#292e42",
      raise: "#2c324a",
      codeBg: "#1b1e2e",
      tblHead: "#1f2335",
      popBg: "#2c324a",
      t1: "#a9b1d6",
      t2: "#8089b3",
      t3: "#545c7e",
      t4: "#3b4261",
      accent: "#7aa2f7",
      ok: "#9ece6a",
      warn: "#e0af68",
      bad: "#f7768e",
      live: "#bb9af7",
      inkPen: "#ff9e64",
    },
  },
  {
    id: "tokyo-night-light",
    name: "Tokyo Night Light",
    family: "Tokyo Night",
    mode: "light",
    source: `${TOKYO_NIGHT}, tokyo-night-light-color-theme.json`,
    colors: {
      page: "#d6d8df",
      panel: "#e6e7ed",
      card: "#e6e7ed",
      raise: "#dcdee3",
      codeBg: "#dcdee3",
      tblHead: "#dadce3",
      popBg: "#e6e7ed",
      t1: "#343b59",
      t2: "#363c4d",
      t3: "#707280",
      t4: "#9da0ab",
      accent: "#2959aa",
      ok: "#33635c",
      warn: "#8f5e15",
      bad: "#8c4351",
      live: "#7b43ba",
      inkPen: "#965027",
    },
  },
];
