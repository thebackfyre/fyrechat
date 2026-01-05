import { STATE } from "./state.js";
import { loadConfig } from "./config.js";
import { applyTheme } from "./theme.js";
import { applyStyleVars } from "./style.js";
import { initDebugDom, updateDebugBanner } from "./debug.js";
import { initRenderDom, addMessage, buildMessageHtmlParts } from "./render.js";
import { loadBadges } from "./badges.js";
import { loadThirdPartyEmotes } from "./emotes/index.js";
import { connectIrc } from "./twitch.js";
import { fetchJson, escapeHtml } from "./utils.js";

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
    // IMPORTANT:
    // Your worker already has an endpoint that returns the channel id.
    // We’ll support multiple common patterns so you don’t have to remember which one:
    //
    //  1) /id/<login>
    //  2) /twitch/id/<login>
    //  3) /users/<login>
    //  4) /helix/users?login=<login>  (proxy style)
    //
    // We try them in order and accept the first that returns a valid id.
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
  const samples = [
    { name: "Fyre", color: "#9bf", text: "Demo — badges + emotes should render 👋" },
    { name: "ModUser", color: "#6f6", text: "Punct test: monkaS... widepeepoHappy! <widepeepoHappy>" },
    { name: "Viewer", color: "#fc6", text: "MIX: Kappa PepeLaugh monkaS catJAM widepeepoHappy" }
  ];

  const demoBadges = [
    "broadcaster/1",
    "moderator/1,subscriber/6",
    "subscriber/3"
  ];

  let i = 0;
  setInterval(() => {
    const s = samples[i % samples.length];
    const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";

    // In demo, we don’t have IRC tags; addMessage expects htmlParts already escaped.
    // Emotes will still render because render.js replaces 3P in text.
    const htmlParts = buildMessageHtmlParts(s.text, "");
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
