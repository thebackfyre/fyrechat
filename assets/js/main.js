import { STATE } from "./state.js";
import { loadConfig } from "./config.js";
import { applyTheme } from "./theme.js";
import { applyStyleVars } from "./style.js";
import { initDebugDom, updateDebugBanner } from "./debug.js";
import { initRenderDom, addMessage, buildMessageHtmlParts } from "./render.js";
import { loadBadges } from "./badges.js";
import { loadThirdPartyEmotes } from "./emotes/index.js";
import { connectIrc } from "./twitch.js";
import { fetchJson } from "./utils.js";

init().catch((e) => {
  console.error("FyreChat init fatal:", e);
});

async function init() {
  initDebugDom();
  initRenderDom();

  const cfg = await loadConfig();
  applyTheme(cfg);
  applyStyleVars(cfg);

  updateDebugBanner(cfg, "Boot…");

  // Resolve channel ID (needed for channel badges + channel emotes)
  await resolveChannelId(cfg);
  updateDebugBanner(cfg, "ID ok");

  await loadBadges(cfg);
  updateDebugBanner(cfg, "Badges ok");

  await loadThirdPartyEmotes(cfg);
  updateDebugBanner(cfg, "Ready");

  if (cfg.demo) runDemo(cfg);
  else connectIrc(cfg);
}

async function resolveChannelId(cfg) {
  STATE.channelId = null;
  STATE.channelIdErr = "";

  // Prefer explicit idProxy, fall back to badgeProxy (so old configs still work)
  const base = cfg.idProxy || cfg.badgeProxy || "";
  if (!base) {
    STATE.channelIdErr = "no idProxy";
    return;
  }

  try {
    const login = encodeURIComponent(cfg.channel);

    const candidates = [
      `${base}/id/${login}`,
      `${base}/twitch/id/${login}`,
      `${base}/users/${login}`,
      `${base}/helix/users?login=${login}`,
    ];

    let lastErr = null;

    for (const url of candidates) {
      try {
        const data = await fetchJson(url, { cache: "no-store" });

        // Accept: {id:""}, {data:{id:""}}, {data:[{id:""}]}
        const id =
          data?.id ||
          data?.data?.id ||
          (Array.isArray(data?.data) ? data.data[0]?.id : null);

        if (id) {
          STATE.channelId = String(id);
          return;
        }

        lastErr = new Error(`No id in response for ${url}`);
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("ID resolve failed");
  } catch (e) {
    STATE.channelIdErr = "id resolve failed";
    console.warn("Channel ID resolve failed:", e);
  }
}

function runDemo(cfg) {
  // -----------------------------
  // Badge tiers we want to cycle
  // -----------------------------
  const demoBadges = [
    "broadcaster/1",
    "moderator/1,subscriber/6",
    "subscriber/1",
    "subscriber/3",
    "subscriber/6",
    "subscriber/12",
  ];

  // ---------------------------------------------------------
  // Twitch emotes: we simulate the IRC emotes tag in demo
  // ---------------------------------------------------------
  const TWITCH_EMOTE_IDS = {
    Kappa: "25",
    // Add more Twitch defaults if you want:
    // PogChamp: "88",
  };

  function buildTwitchEmotesTag(text) {
    // CSP-safe: no RegExp constructors, just deterministic string scanning
    const hitsById = new Map();

    for (const [token, id] of Object.entries(TWITCH_EMOTE_IDS)) {
      const L = token.length;
      let idx = 0;

      while (true) {
        idx = text.indexOf(token, idx);
        if (idx === -1) break;

        const before = idx === 0 ? " " : text[idx - 1];
        const after = idx + L >= text.length ? " " : text[idx + L];

        // Word-ish boundary for demo tokens like "Kappa"
        const isWordChar = (c) => {
          const code = c.charCodeAt(0);
          const isNum = code >= 48 && code <= 57;   // 0-9
          const isUpper = code >= 65 && code <= 90; // A-Z
          const isLower = code >= 97 && code <= 122;// a-z
          const isUnderscore = code === 95;         // _
          return isNum || isUpper || isLower || isUnderscore;
        };

        if (!isWordChar(before) && !isWordChar(after)) {
          const start = idx;
          const end = idx + L - 1;
          if (!hitsById.has(id)) hitsById.set(id, []);
          hitsById.get(id).push(`${start}-${end}`);
        }

        idx += L;
      }
    }

    if (hitsById.size === 0) return "";
    return [...hitsById.entries()]
      .map(([id, ranges]) => `${id}:${ranges.join(",")}`)
      .join("/");
  }

  // ---------------------------------------------------------
  // DEMO TEST MATRIX (self-identifying labels in text)
  // - Twitch emotes render ONLY when emotesTag is provided
  // - 3P emotes render via renderTextWith3PEmotes on text segments
  // ---------------------------------------------------------
  const samples = [
    {
      name: "Fyre",
      color: "#9bf",
      text: "[TWITCH] Kappa should render -> Kappa",
      twitchTag: true,
    },
    {
      name: "Viewer",
      color: "#fc6",
      text: "[3P BASIC] PepeLaugh monkaS widepeepoHappy catJAM",
      twitchTag: false,
    },
    {
      name: "ModUser",
      color: "#6f6",
      text: "[3P EDGE] widepeepoHappy! (widepeepoHappy) <widepeepoHappy> widepeepoHappy...",
      twitchTag: false,
    },
    {
      name: "Viewer",
      color: "#fc6",
      text: "[MIXED] Kappa PepeLaugh monkaS catJAM widepeepoHappy",
      twitchTag: true,
    },
    {
      name: "Viewer",
      color: "#fc6",
      text: "[COLLISION] widepeepoHappy widepeepoHappy! <widepeepoHappy> (widepeepoHappy)",
      twitchTag: false,
    },
  ];

  let i = 0;
  setInterval(() => {
    const s = samples[i % samples.length];

    const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";
    const badgeImgs =
      cfg.badgeProxy && STATE.badgesReady && badgeTag !== "(none)"
        ? demoBadgeUrlsFromTag(badgeTag)
        : [];

    const emotesTag = s.twitchTag ? buildTwitchEmotesTag(s.text) : "";
    const htmlParts = buildMessageHtmlParts(s.text, emotesTag);

    addMessage(cfg, s.name, s.color, htmlParts, badgeImgs);
    i++;
  }, 1100);
}

function demoBadgeUrlsFromTag(badgeTag) {
  const urls = [];
  const parts = String(badgeTag).split(",").filter(Boolean);

  for (const p of parts) {
    const [setId, ver] = p.split("/");
    if (!setId || !ver) continue;

    const chan = STATE.badgeMapChannel.get(setId);
    const glob = STATE.badgeMapGlobal.get(setId);

    const url = (chan?.get(ver)) || (glob?.get(ver));
    if (url) urls.push(url);
  }

  return urls;
}

