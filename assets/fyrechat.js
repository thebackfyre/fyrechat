/* =========================================================
   FyreChat - Overlay Chat Widget (JS)
   - Twitch IRC (anonymous)
   - Multi-bubble stacking (max)
   - TTL + fade-out animation
   - Twitch emotes (native emotes tag)
   - Badges via Cloudflare Worker proxy
   - BTTV + 7TV emotes (global + channel) with caching
   ========================================================= */

/* ---------------------------
   0) Helpers
--------------------------- */
function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { method: "GET", ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

/* ---------------------------
   1) Params + DOM
--------------------------- */
const params = new URLSearchParams(location.search);

const demo  = params.get("demo") === "1";
const debug = params.get("debug") === "1";

const channel = (params.get("ch") || "alveussanctuary").toLowerCase();
const maxParam = params.get("max");
const ttlParam = params.get("ttl");
const fadeParam = params.get("fade");

// Optional config URL (JSON)
const cfgUrl = params.get("cfg"); // e.g. ?cfg=assets/config/fyrechat.default.json

const $debug = document.getElementById("debug");
const $stack = document.getElementById("stack");

if (debug && $debug) $debug.style.display = "block";

/* ---------------------------
   2) Default config (can be overridden by JSON + URI)
--------------------------- */
let config = {
  channel,
  max: 30,
  ttlSeconds: 22,
  fadeSeconds: 2.0,

  // Badges
  badges: {
    enabled: true,
    showInDemo: true
  },

  // Third-party emotes
  emotes: {
    enabled: true,
    cacheMinutes: 360,
    providers: {
      bttv: { enabled: true },
      "7tv": { enabled: true, baseUrl: "https://api.7tv.app/v3" }
    }
  }
};

// Apply URI overrides early (before config fetch finishes, we re-apply later too)
function applyUriOverrides() {
  config.channel = channel;
  config.max = clampInt(maxParam, config.max, 1, 200);
  config.ttlSeconds = clampInt(ttlParam, config.ttlSeconds, 0, 3600);
  config.fadeSeconds = clampFloat(fadeParam, config.fadeSeconds, 0, 30);
}

applyUriOverrides();

/* ---------------------------
   3) Badge Proxy (Cloudflare Worker)
   NOTE: Set this to your working Worker base.
   Example worker: https://twitch-badge-proxy.thebackfyre.workers.dev
--------------------------- */
/* commenting out to make badge proxy configurable
const BADGE_PROXY_BASE = "https://twitch-badge-proxy.thebackfyre.workers.dev"; */
let BADGE_PROXY_BASE = "https://twitch-badge-proxy.thebackfyre.workers.dev";

/* Badge state */
const badgeState = {
  enabled: true,
  showInDemo: true,
  ready: false,
  globalSet: null,   // Twitch badge "sets" JSON (global)
  channelSet: null,  // Twitch badge "sets" JSON (channel)
  channelId: null
};

/* ---------------------------
   4) Third-party emote state
--------------------------- */
const emoteState = {
  channelId: null, // Twitch room-id
  ready: false,
  map: new Map()   // token -> { url, provider }
};

/* ---------------------------
   5) Boot
--------------------------- */
(async function boot() {
  // 5.1 Load JSON config if provided
  if (cfgUrl) {
    try {
      const cfg = await fetchJson(cfgUrl);
      // Shallow merge (simple + predictable)
      config = deepMerge(config, cfg);
    } catch (e) {
      if (debug) setDebug(`Config load failed: ${String(e.message || e)}`);
    }
  }

  // 5.2 Re-apply URI overrides (URI should always win)
  applyUriOverrides();

  // Allow config to override badge proxy base
  if (config.badgeProxy && typeof config.badgeProxy === "string") {
    BADGE_PROXY_BASE = config.badgeProxy.replace(/\/+$/, "");
  }

    // Back-compat: allow config.ttl/config.fade
  if (typeof config.ttl === "number" && !Number.isNaN(config.ttl)) config.ttlSeconds = config.ttl;
  if (typeof config.fade === "number" && !Number.isNaN(config.fade)) config.fadeSeconds = config.fade;


  // 5.3 Apply badge toggles from config
  badgeState.enabled = !!config?.badges?.enabled;
  badgeState.showInDemo = config?.badges?.showInDemo !== false;

  // 5.4 Banner
  if (debug) {
    setDebug(
      (demo ? "DEMO" : "IRC") +
      ` | ch=${config.channel}` +
      ` | max=${config.max}` +
      ` | ttl=${config.ttlSeconds}s fade=${config.fadeSeconds}s` +
      ` | badges=${badgeState.enabled ? "on" : "off"}` +
      ` | emotes=${config?.emotes?.enabled ? "on" : "off"}`
    );
  }

  // 5.5 Start
  if (demo) runDemo();
  else connectIrc(config.channel);
})();

/* ---------------------------
   6) Debug banner helper
--------------------------- */
function setDebug(text) {
  if (!$debug) return;
  $debug.textContent = text;
}

/* ---------------------------
   7) Demo mode
--------------------------- */
function runDemo() {
  const samples = [
    { name: "Fyre", color: "#9bf", text: "FyreChat demo — bubbles stack correctly now 👋" },
    { name: "ModUser", color: "#6f6", text: "Next: BTTV + 7TV emotes + badges rendering." },
    { name: "Viewer", color: "#fc6", text: "Try Kappa, or a 7TV emote if your channel has it." }
  ];

  let i = 0;
  setInterval(() => {
    const s = samples[i++ % samples.length];

    // In demo, we can optionally show a couple of fake badges to confirm rendering.
    // This is just visual testing—real badge data comes from Twitch via Worker in live.
    const fakeBadges = badgeState.showInDemo
      ? [
          { title: "Moderator", url: "https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d1/1" },
          { title: "Subscriber", url: "https://static-cdn.jtvnw.net/badges/v1/0c0179a6-86ee-4f72-9e65-5d0e3c9dcd19/1" }
        ]
      : [];

    const htmlParts = applyThirdPartyEmotesToHtmlParts([escapeHtml(s.text)]);
    addMessage({
      name: s.name,
      color: s.color,
      htmlParts,
      badges: fakeBadges
    });
  }, 1100);
}

/* ---------------------------
   8) Twitch IRC connection
--------------------------- */
function connectIrc(chan) {
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

  ws.addEventListener("open", () => {
    if (debug) setDebug(`Connected ✅ as ${anonNick} (joining #${chan})`);
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send("PASS SCHMOOPIIE");
    ws.send("NICK " + anonNick);
    ws.send("JOIN #" + chan);
  });

  ws.addEventListener("message", async (ev) => {
    const data = String(ev.data || "");
    if (data.startsWith("PING")) {
      ws.send("PONG :tmi.twitch.tv");
      return;
    }

    const lines = data.split("\r\n").filter(Boolean);
    for (const line of lines) {
      if (!line.includes(" PRIVMSG #")) continue;

      const parsed = parsePrivmsg(line);
      if (!parsed) continue;

      // Initialize channel-dependent data once we learn room-id
      const roomId = parsed.tags["room-id"];
      if (roomId) {
        // Badges init
        if (badgeState.enabled && !badgeState.channelId) {
          badgeState.channelId = roomId;
          initBadges(roomId).catch(() => {});
        }
        // Emotes init
        if (config?.emotes?.enabled && !emoteState.channelId) {
          emoteState.channelId = roomId;
          initThirdPartyEmotes(roomId).catch(() => {});
        }
      }

      // Build badges list for this message
      const badges = badgeState.enabled
        ? buildBadgesForMessage(parsed.tags)
        : [];

      // Build message (Twitch emotes first, then BTTV/7TV)
      const htmlParts = applyThirdPartyEmotesToHtmlParts(parsed.htmlParts);

      addMessage({
        name: parsed.name,
        color: parsed.color,
        htmlParts,
        badges
      });
    }
  });

  ws.addEventListener("close", () => {
    if (debug) setDebug("Disconnected — retrying in 2s…");
    setTimeout(() => connectIrc(chan), 2000);
  });

  ws.addEventListener("error", () => {
    if (debug) setDebug("WebSocket error (network/CSP).");
  });
}

/* ---------------------------
   9) Parse PRIVMSG + Twitch emotes
--------------------------- */
function parsePrivmsg(line) {
  let tags = {};
  let rest = line;

  if (rest.startsWith("@")) {
    const spaceIdx = rest.indexOf(" ");
    const rawTags = rest.slice(1, spaceIdx);
    tags = parseTags(rawTags);
    rest = rest.slice(spaceIdx + 1);
  }

  const msgIdx = rest.indexOf(" :");
  if (msgIdx === -1) return null;

  const text = rest.slice(msgIdx + 2);
  const name = tags["display-name"] || "Unknown";
  const color = tags["color"] || "#ffffff";
  const emotes = tags["emotes"] || "";
  const htmlParts = buildMessageHtmlParts(text, emotes);

  return { name, color, htmlParts, tags };
}

function parseTags(raw) {
  const out = {};
  for (const p of raw.split(";")) {
    const eq = p.indexOf("=");
    const k = eq === -1 ? p : p.slice(0, eq);
    const v = eq === -1 ? "" : p.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

/**
 * Twitch native emotes are provided via ranges in the `emotes` tag.
 * We turn the message into an array of HTML parts:
 * - escaped text chunks
 * - <img class="emote"> chunks for Twitch emotes
 */
function buildMessageHtmlParts(text, emotesTag) {
  if (!emotesTag) return [escapeHtml(text)];

  const ranges = [];
  for (const def of emotesTag.split("/").filter(Boolean)) {
    const [id, locs] = def.split(":");
    if (!id || !locs) continue;
    for (const loc of locs.split(",")) {
      const [startStr, endStr] = loc.split("-");
      const start = Number(startStr), end = Number(endStr);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        ranges.push({ start, end, id });
      }
    }
  }
  if (!ranges.length) return [escapeHtml(text)];
  ranges.sort((a,b) => a.start - b.start);

  const parts = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) parts.push(escapeHtml(text.slice(cursor, r.start)));
    parts.push(
      `<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`
    );
    cursor = r.end + 1;
  }
  if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
  return parts;
}

/* ---------------------------
   10) Badges (via Worker)
--------------------------- */
async function initBadges(channelId) {
  // Load global + channel badge sets once
  try {
    const globalUrl = `${BADGE_PROXY_BASE}/badges/global`;
    const channelUrl = `${BADGE_PROXY_BASE}/badges/channels/${channelId}`;

    const [globalSet, channelSet] = await Promise.all([
      fetchJson(globalUrl),
      fetchJson(channelUrl)
    ]);

    badgeState.globalSet = globalSet;
    badgeState.channelSet = channelSet;
    badgeState.ready = true;

    if (debug) {
      const g = countBadgeSets(globalSet);
      const c = countBadgeSets(channelSet);
      setDebug(
        `IRC | ch=${config.channel} | max=${config.max} | ttl=${config.ttlSeconds}s` +
        ` | badges=on (globalSets=${g}, channelSets=${c})` +
        ` | emotes=${config?.emotes?.enabled ? "on" : "off"}`
      );
    }
  } catch (e) {
    if (debug) setDebug(`Badges init failed: ${String(e.message || e)}`);
  }
}

function countBadgeSets(setJson) {
  try {
    const sets = setJson?.badge_sets;
    if (!sets) return 0;
    return Object.keys(sets).length;
  } catch { return 0; }
}

/**
 * tags["badges"] looks like: "moderator/1,subscriber/12"
 * We map those to image URLs from global/channel sets.
 */
function buildBadgesForMessage(tags) {
  if (!badgeState.ready) return [];
  const badgeStr = tags["badges"] || "";
  if (!badgeStr) return [];

  const pairs = badgeStr.split(",").map(s => s.trim()).filter(Boolean);
  if (!pairs.length) return [];

  const out = [];

  for (const pair of pairs) {
    const [setId, version] = pair.split("/");
    if (!setId || !version) continue;

    const badge = findBadge(setId, version);
    if (!badge?.image_url_1x) continue;

    out.push({
      title: badge?.title || setId,
      url: badge.image_url_1x
    });
  }

  return out;
}

function findBadge(setId, version) {
  // Channel-specific should override global
  const fromChannel = badgeState.channelSet?.badge_sets?.[setId]?.versions?.[version];
  if (fromChannel) return fromChannel;

  const fromGlobal = badgeState.globalSet?.badge_sets?.[setId]?.versions?.[version];
  return fromGlobal || null;
}

/* ---------------------------
   11) Third-party emotes (BTTV / 7TV)
--------------------------- */
async function initThirdPartyEmotes(channelId) {
  if (emoteState.ready) return;

  const cacheMinutes = clampInt(config?.emotes?.cacheMinutes, 360, 1, 10080);
  const cacheKey = `fyrechat:emotes:v1:${channelId}`;
  const now = Date.now();

  // localStorage cache
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached && cached.expiresAt > now && Array.isArray(cached.items)) {
      emoteState.map = new Map(
        cached.items.map(x => [x.token, { url: x.url, provider: x.provider }])
      );
      emoteState.ready = true;
      return;
    }
  } catch {}

  const items = [];

  // BTTV: global + channel
  if (config?.emotes?.providers?.bttv?.enabled) {
    try {
      const bttvGlobal = await fetchJson("https://api.betterttv.net/3/cached/emotes/global");
      for (const e of (bttvGlobal || [])) {
        if (!e?.code || !e?.id) continue;
        items.push({
          token: e.code,
          url: `https://cdn.betterttv.net/emote/${e.id}/1x`,
          provider: "bttv"
        });
      }
    } catch {}

    try {
      const bttvChan = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
      const channelEmotes = [
        ...(bttvChan?.channelEmotes || []),
        ...(bttvChan?.sharedEmotes || [])
      ];
      for (const e of channelEmotes) {
        if (!e?.code || !e?.id) continue;
        items.push({
          token: e.code,
          url: `https://cdn.betterttv.net/emote/${e.id}/1x`,
          provider: "bttv"
        });
      }
    } catch {}
  }

  // 7TV: channel emotes
  if (config?.emotes?.providers?.["7tv"]?.enabled) {
    try {
      const base = String(config.emotes.providers["7tv"].baseUrl || "").replace(/\/+$/,"");
      const u = await fetchJson(`${base}/users/twitch/${channelId}`);

      const emotes = u?.emote_set?.emotes || [];
      for (const e of emotes) {
        const name = e?.name;
        const host = e?.data?.host;
        if (!name || !host?.url || !Array.isArray(host.files)) continue;

        // Prefer a small/fast file
        const file =
          host.files.find(f => f.name === "1x.webp") ||
          host.files.find(f => f.name === "1x.png") ||
          host.files[0];

        if (!file?.name) continue;

        items.push({
          token: name,
          url: `https:${host.url}/${file.name}`,
          provider: "7tv"
        });
      }
    } catch {}
  }

  // Build final map (later entries override earlier on collisions)
  const map = new Map();
  for (const it of items) map.set(it.token, { url: it.url, provider: it.provider });

  emoteState.map = map;
  emoteState.ready = true;

  // Cache to localStorage
  try {
    localStorage.setItem(cacheKey, JSON.stringify({
      expiresAt: now + cacheMinutes * 60 * 1000,
      items: Array.from(map.entries()).map(([token, v]) => ({
        token, url: v.url, provider: v.provider
      }))
    }));
  } catch {}
}

/**
 * Applies BTTV/7TV substitutions on *text-only* HTML parts.
 * - We do NOT modify parts that already contain <img> (Twitch emotes)
 * - Token matching is whitespace-based (V1 simple + fast)
 */
function applyThirdPartyEmotesToHtmlParts(htmlParts) {
  if (!config?.emotes?.enabled) return htmlParts;
  if (!emoteState.ready || !emoteState.map?.size) return htmlParts;

  return htmlParts.map(part => {
    if (part.includes("<img")) return part;

    return part.replace(/(\S+)/g, (token) => {
      const hit = emoteState.map.get(token);
      if (!hit) return token;

      const safeUrl = escapeHtml(hit.url);
      const safeAlt = escapeHtml(token);
      return `<img class="emote" alt="${safeAlt}" src="${safeUrl}">`;
    });
  });
}

/* ---------------------------
   12) Render bubble + lifecycle
--------------------------- */
function addMessage({ name, color, htmlParts, badges }) {
  const el = document.createElement("div");
  el.className = "msg";

  const meta = document.createElement("div");
  meta.className = "meta";

  // Badges (optional)
  if (Array.isArray(badges) && badges.length) {
    for (const b of badges) {
      const img = document.createElement("img");
      img.className = "badge";
      img.src = b.url;
      img.alt = "";
      img.title = b.title || "";
      meta.appendChild(img);
    }
  }

  const nameEl = document.createElement("span");
  nameEl.className = "name";
  nameEl.textContent = name;
  nameEl.style.color = color || "#fff";

  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.innerHTML = (htmlParts || []).join("");

  meta.appendChild(nameEl);
  el.appendChild(meta);
  el.appendChild(textEl);

  $stack.appendChild(el);

  // Keep list tight
  while ($stack.children.length > config.max) {
    $stack.removeChild($stack.firstChild);
  }

  // TTL removal
  if (config.ttlSeconds > 0) {
    const removeAtMs = config.ttlSeconds * 1000;
    const fadeMs = Math.max(0, config.fadeSeconds * 1000);

    if (fadeMs > 0 && removeAtMs > fadeMs) {
      setTimeout(() => el.classList.add("out"), removeAtMs - fadeMs);
      setTimeout(() => el.remove(), removeAtMs);
    } else {
      setTimeout(() => el.remove(), removeAtMs);
    }
  }
}

/* ---------------------------
   13) Deep merge (simple utility)
--------------------------- */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };

  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k] && typeof out[k] === "object" ? out[k] : {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
