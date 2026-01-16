export function applyTheme(cfg) {
  const themeLink = document.getElementById("themeLink");
  if (!themeLink) return;

  const theme = String(cfg.theme || "glass").toLowerCase();
  themeLink.href = `./assets/themes/${theme}.css`;
}
