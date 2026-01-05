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
    "moderator/1",
    "subscriber/1",
    "subscriber/6",
    "subscriber/12",
    "subscriber/24",
  ];

  // ---------------------------------------------------------
  // Helper: build Twitch emotesTag by finding token positions
  // (ASCII-only tokens in demo, so JS indices match fine.)
  // ---------------------------------------------------------
  const TWITCH_EMOTE_IDS = {
    Kappa: "25",
    // add more if you want:
    // PogChamp: "88",
  };

  function buildTwitchEmotesTag(text) {
    // Find all occurrences of known twitch emote tokens as whole words
    // and build Twitch-style tag: id:start-end,id:start-end/... grouped by id
    const hitsById = new Map();

    for (const [token, id] of Object.entries(TWITCH_EMOTE_IDS)) {
      const re = new RegExp(`\\b${token}\\b`, "g");
      let m;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + token.length - 1;
        if (!hitsById.has(id)) hitsById.set(id, []);
        hitsById.get(id).push(`${start}-${end}`);
      }
    }

    if (hitsById.size === 0) return "";
    return [...hitsById.entries()]
      .map(([id, ranges]) => `${id}:${ranges.join(",")}`)
      .join("/");
  }

  // ---------------------------------------------------------
  // DEMO TEST MATRIX (self-identifying labels in text)
  // Notes:
  // - Twitch emotes are rendered only when emotesTag is provided.
  // - 3P emotes are rendered by renderTextWith3PEmotes on plain text chunks.
  // ---------------------------------------------------------
  const samples = [
    // Twitch emote(s) — proves buildMessageHtmlParts + emotesTag works like live
    {
      name: "Fyre",
      color: "#9bf",
      text: "[TWITCH] Kappa should render -> Kappa",
      twitchTag: true,
    },

    // 3P single-token checks (global vs channel depends on what’s loaded for that channel)
    // These are still useful because they validate parsing + substitution pipeline.
    {
      name: "Viewer",
      color: "#fc6",
      text: "[3P BASIC] PepeLaugh monkaS widepeepoHappy catJAM",
      twitchTag: false,
    },

    // Punctuation + wrappers (the stuff that kept breaking)
    {
      name: "ModUser",
      color: "#6f6",
      text: "[3P EDGE] widepeepoHappy! (widepeepoHappy) <widepeepoHappy> widepeepoHappy...",
      twitchTag: false,
    },

    // Mixed line: Twitch + 3P in same message
    {
      name: "Viewer",
      color: "#fc6",
      text: "[MIXED] Kappa PepeLaugh monkaS catJAM widepeepoHappy",
      twitchTag: true, // includes Kappa
    },

    // Collision / ambiguity stress (same token might exist in multiple providers)
    // This just verifies: token replacement happens, and does NOT break the line.
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

    // Rotate badge tiers, but only if demoBadges enabled
    const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";
    const badgeImgs =
      cfg.badgeProxy && STATE.badgesReady && badgeTag !== "(none)"
        ? demoBadgeUrlsFromTag(badgeTag)
        : [];

    // Build parts like live:
    // - If twitchTag true, we generate an emotesTag for Kappa positions.
    // - Otherwise emotesTag is empty and 3P replacement still occurs in text segments.
    const emotesTag = s.twitchTag ? buildTwitchEmotesTag(s.text) : "";
    const htmlParts = buildMessageHtmlParts(s.text, emotesTag);

    addMessage(cfg, s.name, s.color, htmlParts, badgeImgs);
    i++;
  }, 1100);
}


  let i = 0;
  setInterval(() => {
    const s = samples[i % samples.length];
    const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";

    // Demo should behave like live:
    // - still uses buildMessageHtmlParts()
    // - and we simulate Twitch's IRC emotes tag so Kappa renders in demo.
    //
    // In the string "MIX: Kappa ...", Kappa starts at index 5 and ends at 9.
    // Twitch emote id for Kappa is 25.
    const emotesTag = s.text.includes("Kappa") ? "25:5-9" : "";
    const htmlParts = buildMessageHtmlParts(s.text, emotesTag);

    const badgeImgs = (cfg.badgeProxy && STATE.badgesReady && badgeTag !== "(none)")
      ? demoBadgeUrlsFromTag(badgeTag)
      : [];

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

