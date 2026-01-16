import { STATE } from "./state.js";
import { clampInt, clampFloat, structuredCloneSafe, deepMerge } from "./utils.js";

const params = new URLSearchParams(location.search);

// Keep your baseline defaults minimal; real defaults come from JSON.
export const BASE_DEFAULTS = {
  channel: "alveussanctuary",
  max: 8,
  ttl: 22,
  fade: 2,
  debug: false,
  demo: false,
  demoBadges: false,
  theme: "glass",
  badgeProxy: "https://twitch-badge-proxy.thebackfyre.workers.dev",
  idProxy: "https://twitch-badge-proxy.thebackfyre.workers.dev",
  emotes: {
    enabled: true,
    providers: {
      bttv: { enabled: true },
      "7tv": { enabled: true, baseUrl: "https://7tv.io/v3" },
      ffz: { enabled: true }
    },
    cacheMinutes: 360
  },
  style: {}
};

export async function loadConfig() {
  let cfg = structuredCloneSafe(BASE_DEFAULTS);

  // Load default JSON (relative to fyrechat.html)
  const v = params.get("v") || String(Date.now());
  const url = `./assets/config/fyrechat.default.json?v=${encodeURIComponent(v)}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status} ${res.statusText}`);
    const json = await res.json();
    cfg = deepMerge(cfg, json);
  } catch (e) {
    console.warn("Config load failed, using BASE_DEFAULTS:", e);
  }

  cfg = applyUriOverrides(cfg);

  // Normalize
  cfg.channel = String(cfg.channel || "alveussanctuary").toLowerCase();
  cfg.max = clampInt(cfg.max, 8, 1, 200);
  cfg.ttl = clampInt(cfg.ttl, 22, 0, 3600);
  cfg.fade = clampFloat(cfg.fade, 2, 0, 30);
  cfg.debug = !!cfg.debug;
  cfg.demo = !!cfg.demo;
  cfg.demoBadges = !!cfg.demoBadges;

  if (!cfg.emotes) cfg.emotes = structuredCloneSafe(BASE_DEFAULTS.emotes);
  if (!cfg.style) cfg.style = {};

  STATE.cfg = cfg;
  return cfg;
}

function applyUriOverrides(cfg) {
  // Scalars
  if (params.has("ch")) cfg.channel = params.get("ch");
  if (params.has("channel")) cfg.channel = params.get("channel");
  if (params.has("max")) cfg.max = Number(params.get("max"));
  if (params.has("ttl")) cfg.ttl = Number(params.get("ttl"));
  if (params.has("fade")) cfg.fade = Number(params.get("fade"));
  if (params.has("debug")) cfg.debug = params.get("debug") === "1";
  if (params.has("demo")) cfg.demo = params.get("demo") === "1";
  if (params.has("demoBadges")) cfg.demoBadges = params.get("demoBadges") === "1";
  if (params.has("badgeProxy")) cfg.badgeProxy = params.get("badgeProxy");
  if (params.has("theme")) cfg.theme = params.get("theme");
  if (params.has("idProxy")) cfg.idProxy = params.get("idProxy");
  // Toggles
  if (params.has("badges") && params.get("badges") === "0") cfg.badgeProxy = "";
  if (params.has("emotes")) {
    const on = params.get("emotes") === "1";
    cfg.emotes = cfg.emotes || {};
    cfg.emotes.enabled = on;
  }

  // Provider toggles
  cfg.emotes = cfg.emotes || {};
  cfg.emotes.providers = cfg.emotes.providers || {};

  if (params.has("bttv")) {
    cfg.emotes.providers.bttv = cfg.emotes.providers.bttv || {};
    cfg.emotes.providers.bttv.enabled = params.get("bttv") === "1";
  }
  if (params.has("7tv")) {
    cfg.emotes.providers["7tv"] = cfg.emotes.providers["7tv"] || {};
    cfg.emotes.providers["7tv"].enabled = params.get("7tv") === "1";
  }
  if (params.has("ffz")) {
    cfg.emotes.providers.ffz = cfg.emotes.providers.ffz || {};
    cfg.emotes.providers.ffz.enabled = params.get("ffz") === "1";
  }

  // Style overrides
  cfg.style = cfg.style || {};
  const setStyle = (key) => {
    const direct = params.get(key);
    const nested = params.get(`style.${key}`);
    const v = (direct ?? nested);
    if (v !== null && v !== undefined && v !== "") cfg.style[key] = v;
  };

  // Badge styling
  setStyle("badgeSize");
  setStyle("badgeGap");
  setStyle("badgePadRight");

  // Emote styling
  setStyle("emoteSize");
  setStyle("emoteBaseline");
  setStyle("emotePadX");

  // Typography
  setStyle("nameSize");
  setStyle("nameWeight");
  setStyle("textSize");
  setStyle("lineHeight");

  return cfg;
}
