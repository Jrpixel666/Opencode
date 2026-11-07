// Omarchy ships a set of desktop themes you flip between; these are the same palettes,
// applied as CSS variables. Tokyo Night is the default, as on Omarchy.
export const THEMES = {
  "tokyo-night": { name: "Tokyo Night", dark: true, bg: "#1a1b26", bg2: "#16161e", surface: "#24283b", fg: "#c0caf5", muted: "#565f89", accent: "#7aa2f7", green: "#9ece6a", yellow: "#e0af68", red: "#f7768e", purple: "#bb9af7", cyan: "#7dcfff" },
  catppuccin: { name: "Catppuccin", dark: true, bg: "#1e1e2e", bg2: "#181825", surface: "#313244", fg: "#cdd6f4", muted: "#6c7086", accent: "#89b4fa", green: "#a6e3a1", yellow: "#f9e2af", red: "#f38ba8", purple: "#cba6f7", cyan: "#94e2d5" },
  "catppuccin-latte": { name: "Catppuccin Latte", dark: false, bg: "#eff1f5", bg2: "#e6e9ef", surface: "#ccd0da", fg: "#4c4f69", muted: "#7c7f93", accent: "#1e66f5", green: "#40a02b", yellow: "#df8e1d", red: "#d20f39", purple: "#8839ef", cyan: "#179299" },
  everforest: { name: "Everforest", dark: true, bg: "#2d353b", bg2: "#232a2e", surface: "#3d484d", fg: "#d3c6aa", muted: "#859289", accent: "#a7c080", green: "#a7c080", yellow: "#dbbc7f", red: "#e67e80", purple: "#d699b6", cyan: "#83c092" },
  gruvbox: { name: "Gruvbox", dark: true, bg: "#282828", bg2: "#1d2021", surface: "#3c3836", fg: "#ebdbb2", muted: "#928374", accent: "#d79921", green: "#b8bb26", yellow: "#fabd2f", red: "#fb4934", purple: "#d3869b", cyan: "#8ec07c" },
  kanagawa: { name: "Kanagawa", dark: true, bg: "#1f1f28", bg2: "#16161d", surface: "#2a2a37", fg: "#dcd7ba", muted: "#727169", accent: "#7e9cd8", green: "#98bb6c", yellow: "#e6c384", red: "#ff5d62", purple: "#957fb8", cyan: "#7fb4ca" },
  nord: { name: "Nord", dark: true, bg: "#2e3440", bg2: "#272c36", surface: "#3b4252", fg: "#d8dee9", muted: "#7b88a1", accent: "#88c0d0", green: "#a3be8c", yellow: "#ebcb8b", red: "#bf616a", purple: "#b48ead", cyan: "#8fbcbb" },
  "rose-pine": { name: "Rosé Pine", dark: true, bg: "#191724", bg2: "#1f1d2e", surface: "#26233a", fg: "#e0def4", muted: "#6e6a86", accent: "#ebbcba", green: "#9ccfd8", yellow: "#f6c177", red: "#eb6f92", purple: "#c4a7e7", cyan: "#9ccfd8" },
  "matte-black": { name: "Matte Black", dark: true, bg: "#121212", bg2: "#0b0b0b", surface: "#1f1f1f", fg: "#bebebe", muted: "#6b6b6b", accent: "#e0a030", green: "#8fa876", yellow: "#e0a030", red: "#d35f5f", purple: "#a28bb5", cyan: "#7a9fa8" },
};

export function applyTheme(id) {
  const t = THEMES[id] || THEMES["tokyo-night"];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t)) if (typeof v === "string" && v.startsWith("#")) root.style.setProperty(`--${k}`, v);
  root.style.colorScheme = t.dark ? "dark" : "light";
  root.dataset.theme = id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bg2);
  return t;
}
