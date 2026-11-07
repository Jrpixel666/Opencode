// Warm light and dark palettes in the style of the Claude mobile app.
// "system" follows the phone's dark-mode setting.
export const PALETTES = {
  light: {
    bg: "#FAF9F5", drawer: "#F3F1EA", surface: "#FFFFFF", bubble: "#F0EEE6", code: "#F5F4ED",
    fg: "#141413", fg2: "#3D3D3A", muted: "#73726C", line: "#E6E3D8",
    accent: "#D97757", accentfg: "#FFFFFF", green: "#3F7D3A", red: "#B53333", yellow: "#9A6A12",
    scrim: "rgba(20,20,19,0.32)", shadow: "0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.06)",
  },
  dark: {
    bg: "#262624", drawer: "#1F1E1D", surface: "#30302E", bubble: "#141413", code: "#1F1E1D",
    fg: "#FAF9F5", fg2: "#C2C0B6", muted: "#9C9A92", line: "#3E3E3A",
    accent: "#D97757", accentfg: "#FFFFFF", green: "#8DBF6E", red: "#E5675B", yellow: "#D9A441",
    scrim: "rgba(0,0,0,0.5)", shadow: "0 1px 2px rgba(0,0,0,.2), 0 4px 16px rgba(0,0,0,.25)",
  },
};

const media = matchMedia("(prefers-color-scheme: dark)");

export function applyAppearance(mode = "system") {
  const dark = mode === "dark" || (mode === "system" && media.matches);
  const p = PALETTES[dark ? "dark" : "light"];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(p)) root.style.setProperty(`--${k}`, v);
  root.style.colorScheme = dark ? "dark" : "light";
  root.dataset.appearance = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", p.bg);
  return dark;
}

export function onSystemAppearanceChange(fn) {
  media.addEventListener("change", fn);
}
