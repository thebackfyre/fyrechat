export function applyStyleVars(cfg) {
  const s = cfg.style || {};
  const root = document.documentElement.style;

  const set = (name, val) => {
    if (val === undefined || val === null || val === "") return;
    root.setProperty(name, String(val));
  };

  // Badges
  set("--badgeSize", s.badgeSize);
  set("--badgeGap", s.badgeGap);
  set("--badgePadRight", s.badgePadRight);

  // Emotes
  set("--emoteSize", s.emoteSize);
  set("--emoteBaseline", s.emoteBaseline);
  set("--emotePadX", s.emotePadX);

  // Typography
  set("--nameSize", s.nameSize);
  set("--nameWeight", s.nameWeight);
  set("--textSize", s.textSize);
  set("--lineHeight", s.lineHeight);
}
