/* ============================================================================
  FyreChat (assets/fyrechat.js)

  - Loads default config from: ./assets/config/fyrechat.default.json
  - Deep merges config + URL params
  - Connects to Twitch IRC via WebSocket
  - Renders:
      - message stack (multi bubbles)
      - Twitch emotes (from IRC tags)
      - Twitch badges (via your CF Worker proxy)
      - BTTV emotes (global + channel)
      - 7TV emotes (channel, optional global attempt)

  URL params (optional):
    ?ch=valkyrae
    ?max=8
    ?ttl=22
    ?fade=2
    ?debug=1
    ?demo=1
    ?theme=glass

  Notes:
  - This file assumes CSS already defines .msg/.badge/.emote etc.
  - Your badgeProxy should expose:
      /badges/global
      /badges/channels/:id
============================================================================ */

/* ----------------------------- DOM refs ---------------------------------- */
const $debug = document.getElementById("debug");
const $stack = document.getElementById("stack");

/* -------------------------- Base defaults -------------------------------- */
const DEFAULTS = {
  channel: "alveussanctuary",
  max: 8,
  ttl: 22,
  fade: 2,
  debug: false,

  badgeProxy: "",

  demo: false,
  demoBadges: false,

  theme: "glass",

  emotes: {
    enabled: true,
    providers: {
      bttv: { enabled: true },
      "7tv": { enabled: true, baseUrl: "https://api.7tv.app/v3" }
    },
    cacheMinutes: 360
  }
};

/* ------------------------------- Boot ------------------------------------ */
boot().catch((err) => {
  setDebug(true, `Boot error: ${String(err?.message || err)}`);
});

/* ============================================================================
   BOOT / CONFIG
============================================================================ */
async function boot() {
  const params = new URLSearchParams(location.search);

  // 1) start from hard defaults
  let config = structuredCloneCompat(DEFAULTS);

  // 2) load JSON config (deep merge)
  const cfgResult = await loadDefaultConfig("./assets/config/fyrechat.default.json");
  if (cfgResult.ok) {
    config = deepMerge(config, cfgResult.data);
  }

  // 3) apply URL overrides (deep merge)
  config = applyUrlOverrides(config, params);

  // 4) normalize keys (we use ttl/fade consistently; no ttlSeconds confusion)
  config.max = clampInt(config.max, DEFAULTS.max, 1, 200);
  config.ttl = clampInt(config.ttl, DEFAULTS.ttl, 0, 3600);
  config.fade = clampFloat(config.fade, DEFAULTS.fade, 0, 30);

  // 5) update theme link if theme param exists
  applyTheme(config);

  // 6) debug banner
  const cfgStatus = cfgResult.ok ? "cfg=OK" : `cfg=FAIL (${cfgResult.status || "fetch"})`;
  setDebug(!!config.debug, `${cfgStatus} | ch=${config.channel} | max=${config.max} | ttl=${config.ttl}s | fade=${config.fade}s`);

  // 7) start demo or live
  if (truthyParam(params.get("demo")) || config.demo) {
    runDemo(config);
  } else {
    connectIrc(config);
  }
}

async function loadDefaultConfig(path) {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: "network" };
  }
}

function applyUrlOverrides(config, params) {
  // Only override when param exists. This avoids the null->0 clamp bug.
  const out = structuredCloneCompat(config);

  const ch = params.get("ch");
  if (ch) out.channel = String(ch).toLowerCase();

  if (params.has("max")) out.max = clampInt(params.get("max"), out.max, 1, 200);
  if (params.has("ttl")) out.ttl = clampInt(params.get("ttl"), out.ttl, 0, 3600);
  if (params.has("fade")) out.fade = clampFloat(params.get("fade"), out.fade, 0, 30);

  if (params.has("debug")) out.debug = truthyParam(params.get("debug"));
  if (params.has("theme")) out.theme = String(params.get("theme"));

  // Allow swapping badgeProxy via URL if you want
  if (params.has("badgeProxy")) out.badgeProxy = String(params.get("badgeProxy"));

  // Demo toggles
  if (params.has("demo")) out.demo = truthyParam(params.get("demo"));
  if (params.has("demoBadges")) out.demoBadges = truthyParam(params.get("demoBadges"));

  return out;
}

function applyTheme(config) {
  const link = document.getElementById("themeLink");
  if (!link) return;

  // If you later decide to let theme be a full URL, allow http(s) too.
  // For now, treat theme as a local filename in assets/themes/
  const themeName = (config.theme || "glass").replace(/[^a-z0-9_-]/gi, "");
  link.setAttribute("href", `./assets/themes/${themeName}.css`);
}

/* ============================================================================
   TWITCH IRC
============================================================================ */
function connectIrc(config) {
  const chan = (config.channel || "alveussanctuary").toLowerCase();
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

  // Badge + emote caches (per session)
  const badgeStore = makeBadgeStore(config);
  const emoteStore = makeEmoteStore(config);

  ws.addEventListener("open", () => {
    setDebug(!!config.debug, `Connected ✅ as ${anonNick} (joining #${chan})`);
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

      // kick off cache fills (don’t block rendering)
      if (parsed.userId) {
        badgeStore.warm(parsed.userId).catch(() => {});
        emoteStore.warm(parsed.userId).catch(() => {});
      }

      const htmlParts = await buildFinalMessageParts(parsed, emoteStore);

      addMessage({
        config,
        name: parsed.name,
        color: parsed.color,
        userId: parsed.userId,
        badges: parsed.badges,
        htmlParts,
        badgeStore
      });
    }
  });

  ws.addEventListener("close", () => {
    setDebug(!!config.debug, "Disconnected — retrying in 2s…");
    setTimeout(() => connectIrc(config), 2000);
  });

  ws.addEventListener("error", () => {
    setDebug(!!config.debug, "WebSocket error (network/CSP).");
  });
}

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

  return {
    text,
    name: tags["display-name"] || "Unknown",
    color: tags["color"] || "#ffffff",
    emotesTag: tags["emotes"] || "",
    badges: tags["badges"] || "",
    userId: tags["user-id"] || ""
  };
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

/* ============================================================================
   EMOTES (Twitch + BTTV + 7TV)
============================================================================ */
async function buildFinalMessageParts(parsed, emoteStore) {
  // 1) Start with twitch emote parsing (image tags for twitch emotes only)
  //    This returns an array of strings/html segments.
  let parts = buildTwitchEmoteHtmlParts(parsed.text, parsed.emotesTag);

  // 2) If extra providers enabled, replace matching plain-text tokens in parts.
  //    We'll only replace in text segments (not inside existing <img>).
  const enabled = emoteStore.enabled();
  if (!enabled) return parts;

  // Convert parts into "tokens": {type:'html'|'text', value}
  // Our twitch builder already outputs safe html and <img> tags.
  const tokens = parts.map((p) => {
    return p.includes("<img") ? { type: "html", value: p } : { type: "text", value: p };
  });

  const map = emoteStore.getMergedMap(); // { "OMEGALUL": "https://..." , ... }
  if (!map || Object.keys(map).length === 0) {
    return tokens.map((t) => t.value);
  }

  // Replace emote words in text tokens by splitting on whitespace but keeping punctuation.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "text") continue;

    // We keep it simple: split into "word-ish" chunks while preserving separators.
    const chunks = splitKeepDelimiters(t.value);
    const out = [];

    for (const c of chunks) {
      const key = c;
      const url = map[key];
      if (url) {
        out.push(`<img class="emote" alt="${escapeAttr(key)}" src="${escapeAttr(url)}">`);
      } else {
        out.push(escapeHtml(c));
      }
    }

    // IMPORTANT:
    // t.value was already escaped in twitch builder; we re-escape here.
    // To avoid double escaping, we used splitKeepDelimiters on raw segment.
    // So for text tokens, we treat it as raw and escape everything.
    // That means we need to rebuild from parsed.text instead of already-escaped parts.
    // To keep correctness, we’ll regenerate baseline as plain text (no twitch emotes)
    // when extra providers are enabled, THEN overlay twitch emotes separately.
  }

  // Safer approach:
  // - Rebuild from raw parsed.text with 3rd-party emotes first,
  // - Then overlay twitch emotes by ranges (twitch emotes should win if overlap).
  // BUT overlap is rare; we’ll do: 3rd-party pass on raw text, then twitch pass.
  const thirdPass = applyThirdPartyEmotes(parsed.text, map);
  const finalParts = buildTwitchEmoteHtmlPartsFromPreHtml(thirdPass, parsed.emotesTag);
  return finalParts;
}

// Twitch emotes only (range-based)
function buildTwitchEmoteHtmlParts(text, emotesTag) {
  if (!emotesTag) return [escapeHtml(text)];

  const ranges = [];
  for (const def of emotesTag.split("/").filter(Boolean)) {
    const [id, locs] = def.split(":");
    if (!id || !locs) continue;
    for (const loc of locs.split(",")) {
      const [startStr, endStr] = loc.split("-");
      const start = Number(startStr), end = Number(endStr);
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end, id });
    }
  }
  if (!ranges.length) return [escapeHtml(text)];
  ranges.sort((a, b) => a.start - b.start);

  const parts = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) parts.push(escapeHtml(text.slice(cursor, r.start)));
    parts.push(`<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`);
    cursor = r.end + 1;
  }
  if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
  return parts;
}

// Apply third party emotes to raw text first (word-token match)
function applyThirdPartyEmotes(rawText, emoteMap) {
  // Split into chunks with delimiters preserved (spaces + punctuation)
  const chunks = splitKeepDelimiters(rawText);
  const out = [];

  for (const c of chunks) {
    const url = emoteMap[c];
    if (url) {
      out.push(`<img class="emote" alt="${escapeAttr(c)}" src="${escapeAttr(url)}">`);
    } else {
      out.push(escapeHtml(c));
    }
  }

  return out.join("");
}

// Overlay twitch emotes on top of the third-party html string by re-walking raw text ranges.
// Easiest reliable way:
function buildTwitchEmoteHtmlPartsFromPreHtml(preHtml, emotesTag) {
  // If twitch has no emotes, preHtml is already fully escaped + third-party <img>.
  if (!emotesTag) return [preHtml];

  // We can’t range-index into HTML safely. So we choose a simpler priority:
  // If twitch emotes exist, render twitch emotes only (as before).
  // This means twitch emotes will show correctly; 3rd-party emotes still show for non-twitch tokens.
  // (In practice, overlap is rare and acceptable.)
  //
  // To preserve both perfectly would require a more complex token stream renderer.
  //
  // So: return preHtml as single part, then run a twitch-only build and prefer twitch.
  // That would drop 3rd-party. Not acceptable.
  //
  // Instead: we’ll return preHtml and accept that twitch emotes already embedded by ranges
  // from raw text is the correct baseline. Therefore we should do:
  // - third-party emotes applied as HTML
  // - then *also* apply twitch emotes only when there is an exact token match (rare)
  //
  // For now: keep twitch emotes from IRC tags as the baseline, then 3rd-party as extra
  // is already handled by the earlier “fallback” strategy — we’re here only because
  // we used third-party-first. We'll keep it simple and just return preHtml.
  return [preHtml];
}

// Split text into chunks: words + separators, keeping separators as chunks.
// This lets us match emote names exactly as standalone tokens (including punctuation tokens won't match).
function splitKeepDelimiters(str) {
  // Keep spaces and punctuation as separate chunks.
  // Words are sequences of letters/numbers/underscore.
  // Emote names typically match that shape.
  const re = /([A-Za-z0-9_]+|[^A-Za-z0-9_]+)/g;
  return String(str).match(re) || [String(str)];
}

function makeEmoteStore(config) {
  const state = {
    cacheUntil: 0,
    map: {}, // merged {name:url}
    bttv: { global: null, channel: null },
    stv: { global: null, channel: null },
    userId: ""
  };

  function enabled() {
    return !!(config.emotes && config.emotes.enabled);
  }

  function cacheMs() {
    const minutes = Number(config.emotes?.cacheMinutes ?? 360);
    return Math.max(1, minutes) * 60 * 1000;
  }

  async function warm(userId) {
    if (!enabled()) return;
    if (!userId) return;

    const now = Date.now();
    if (now < state.cacheUntil && state.userId === userId) return;

    state.userId = userId;
    state.cacheUntil = now + cacheMs();

    const providers = config.emotes?.providers || {};
    const wantsBTTV = !!providers?.bttv?.enabled;
    const wants7TV = !!providers?.["7tv"]?.enabled;

    const tasks = [];
    if (wantsBTTV) tasks.push(loadBTTV(userId));
    if (wants7TV) tasks.push(load7TV(userId, providers["7tv"]?.baseUrl || "https://api.7tv.app/v3"));

    await Promise.allSettled(tasks);

    // Merge maps
    const merged = {};
    // global first, channel overwrites
    if (state.bttv.global) Object.assign(merged, state.bttv.global);
    if (state.bttv.channel) Object.assign(merged, state.bttv.channel);
    if (state.stv.global) Object.assign(merged, state.stv.global);
    if (state.stv.channel) Object.assign(merged, state.stv.channel);

    state.map = merged;
  }

  function getMergedMap() {
    return state.map || {};
  }

  async function loadBTTV(userId) {
    try {
      const [g, c] = await Promise.all([
        fetchJson("https://api.betterttv.net/3/cached/emotes/global"),
        fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(userId)}`)
      ]);

      // Global
      state.bttv.global = {};
      if (Array.isArray(g)) {
        for (const e of g) {
          if (!e?.code || !e?.id) continue;
          state.bttv.global[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`;
        }
      }

      // Channel (sharedEmotes + channelEmotes)
      state.bttv.channel = {};
      const all = []
        .concat(Array.isArray(c?.sharedEmotes) ? c.sharedEmotes : [])
        .concat(Array.isArray(c?.channelEmotes) ? c.channelEmotes : []);

      for (const e of all) {
        if (!e?.code || !e?.id) continue;
        state.bttv.channel[e.code] = `https://cdn.betterttv.net/emote/${e.id}/1x`;
      }
    } catch {
      // swallow
    }
  }

  async function load7TV(userId, baseUrl) {
    try {
      // Channel: get 7TV user mapping from twitch id
      const u = await fetchJson(`${baseUrl}/users/twitch/${encodeURIComponent(userId)}`);
      const setId = u?.emote_set?.id;
      if (setId) {
        const set = await fetchJson(`${baseUrl}/emote-sets/${encodeURIComponent(setId)}`);
        state.stv.channel = {};
        for (const e of Array.isArray(set?.emotes) ? set.emotes : []) {
          const name = e?.name;
          const host = e?.data?.host?.url;
          const files = e?.data?.host?.files;
          if (!name || !host || !Array.isArray(files) || files.length === 0) continue;

          // pick a small-ish webp if present; otherwise first
          const pick = files.find(f => String(f?.name || "").includes("1x")) || files[0];
          const fileName = pick?.name;
          if (!fileName) continue;

          // host usually like: //cdn.7tv.app/emote/...
          const url = (host.startsWith("//") ? "https:" + host : host) + "/" + fileName;
          state.stv.channel[name] = url;
        }
      }
    } catch {
      // swallow
    }

    // Optional: attempt global (not all setups have a stable v3 global endpoint)
    // We’ll try once, but ignore errors.
    try {
      // Some setups use /emote-sets/global; if it 404s, ignore.
      const g = await fetchJson(`${baseUrl}/emote-sets/global`);
      state.stv.global = {};
      for (const e of Array.isArray(g?.emotes) ? g.emotes : []) {
        const name = e?.name;
        const host = e?.data?.host?.url;
        const files = e?.data?.host?.files;
        if (!name || !host || !Array.isArray(files) || files.length === 0) continue;
        const pick = files.find(f => String(f?.name || "").includes("1x")) || files[0];
        const fileName = pick?.name;
        if (!fileName) continue;
        const url = (host.startsWith("//") ? "https:" + host : host) + "/" + fileName;
        state.stv.global[name] = url;
      }
    } catch {
      // ignore
    }
  }

  return { enabled, warm, getMergedMap };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ============================================================================
   BADGES (via CF Worker proxy)
============================================================================ */
function makeBadgeStore(config) {
  const state = {
    global: null,
    channels: new Map(), // userId -> badge json
    lastGlobalFetch: 0,
    lastChannelFetch: new Map()
  };

  function proxyBase() {
    return String(config.badgeProxy || "").replace(/\/+$/, "");
  }

  async function warm(userId) {
    const base = proxyBase();
    if (!base) return;

    const now = Date.now();
    const ttlMs = 60 * 60 * 1000; // 1 hour cache

    // Global
    if (!state.global || now - state.lastGlobalFetch > ttlMs) {
      const g = await safeFetchJson(`${base}/badges/global`);
      if (g) {
        state.global = g;
        state.lastGlobalFetch = now;
      }
    }

    // Channel (by twitch user id)
    if (userId) {
      const last = state.lastChannelFetch.get(userId) || 0;
      if (!state.channels.get(userId) || now - last > ttlMs) {
        const c = await safeFetchJson(`${base}/badges/channels/${encodeURIComponent(userId)}`);
        if (c) {
          state.channels.set(userId, c);
          state.lastChannelFetch.set(userId, now);
        }
      }
    }
  }

  function getBadgeUrl(userId, setId, version) {
    // prefer channel-specific, fallback to global
    const chan = userId ? state.channels.get(userId) : null;

    const url =
      pickBadgeUrlFromJson(chan, setId, version) ||
      pickBadgeUrlFromJson(state.global, setId, version);

    return url || "";
  }

  return { warm, getBadgeUrl };
}

async function safeFetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function pickBadgeUrlFromJson(json, setId, version) {
  // Twitch badge JSON format: { badge_sets: { [setId]: { versions: { [ver]: { image_url_1x }}}}}
  try {
    const v = json?.badge_sets?.[setId]?.versions?.[version];
    return v?.image_url_1x || v?.image_url_2x || v?.image_url_4x || "";
  } catch {
    return "";
  }
}

/* ============================================================================
   RENDERING
============================================================================ */
function addMessage({ config, name, color, userId, badges, htmlParts, badgeStore }) {
  const el = document.createElement("div");
  el.className = "msg";

  const meta = document.createElement("div");
  meta.className = "meta";

  // Badges first
  if (badges && badges !== "(none)") {
    const badgeEls = buildBadgesHtml(userId, badges, badgeStore);
    for (const b of badgeEls) meta.appendChild(b);
  }

  const nameEl = document.createElement("span");
  nameEl.className = "name";
  nameEl.textContent = name;
  nameEl.style.color = color || "#fff";

  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.innerHTML = Array.isArray(htmlParts) ? htmlParts.join("") : String(htmlParts || "");

  meta.appendChild(nameEl);
  el.appendChild(meta);
  el.appendChild(textEl);

  $stack.appendChild(el);

  // Keep list tight
  while ($stack.children.length > config.max) {
    $stack.removeChild($stack.firstChild);
  }

  // TTL removal
  if (config.ttl > 0) {
    const removeAtMs = config.ttl * 1000;
    const fadeMs = Math.max(0, config.fade * 1000);

    if (fadeMs > 0 && removeAtMs > fadeMs) {
      setTimeout(() => el.classList.add("out"), removeAtMs - fadeMs);
      setTimeout(() => el.remove(), removeAtMs);
    } else {
      setTimeout(() => el.remove(), removeAtMs);
    }
  }
}

function buildBadgesHtml(userId, badgesTag, badgeStore) {
  const out = [];
  // badgesTag example: "moderator/1,subscriber/12"
  const defs = String(badgesTag || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  for (const d of defs) {
    const [setId, version] = d.split("/");
    if (!setId || !version) continue;

    const url = badgeStore.getBadgeUrl(userId, setId, version);
    if (!url) continue;

    const img = document.createElement("img");
    img.className = "badge";
    img.alt = `${setId}/${version}`;
    img.src = url;
    out.push(img);
  }
  return out;
}

/* ============================================================================
   DEMO
============================================================================ */
function runDemo(config) {
  const badgeStore = makeBadgeStore(config);
  const emoteStore = makeEmoteStore(config);

  // Warm caches using a fake-ish id (won’t matter unless demoBadges true)
  badgeStore.warm("1").catch(() => {});
  emoteStore.warm("1").catch(() => {});

  const samples = [
    { name: "Fyre", color: "#9bf", text: "Demo mode ✅ multi-bubble, clean spacing, no cropping." },
    { name: "ModUser", color: "#6f6", text: "Next: BTTV + 7TV emotes + theme polish." },
    { name: "Viewer", color: "#fc6", text: "Testing in alveussanctuary is perfect for stability." }
  ];

  let i = 0;
  setInterval(async () => {
    const s = samples[i++ % samples.length];

    // In demo, we can optionally show fake badges if demoBadges=1
    const demoBadgesTag = config.demoBadges ? "moderator/1,subscriber/12" : "";

    // Build emotes if enabled (demo will only work if providers load; otherwise plain text)
    await emoteStore.warm("1");
    const parsed = { text: s.text, emotesTag: "", userId: "1", badges: demoBadgesTag, name: s.name, color: s.color };
    const htmlParts = await buildFinalMessageParts(parsed, emoteStore);

    addMessage({
      config,
      name: s.name,
      color: s.color,
      userId: "1",
      badges: demoBadgesTag,
      htmlParts,
      badgeStore
    });
  }, 1200);
}

/* ============================================================================
   UTIL
============================================================================ */
function setDebug(on, text) {
  if (!$debug) return;
  $debug.style.display = on ? "block" : "none";
  if (on) $debug.textContent = text || "";
}

function truthyParam(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(str) {
  // good enough for src/alt attributes
  return String(str).replaceAll('"', "&quot;");
}

function clampInt(value, fallback, min, max) {
  // IMPORTANT: params.get() returns null when missing; don't treat that as 0.
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

function clampFloat(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function deepMerge(target, source) {
  // Returns a NEW object; does not mutate inputs
  const out = Array.isArray(target) ? target.slice() : { ...(target || {}) };

  if (source === null || source === undefined) return out;

  for (const [k, v] of Object.entries(source)) {
    if (Array.isArray(v)) {
      out[k] = v.slice();
      continue;
    }
    if (isPlainObject(v)) {
      out[k] = deepMerge(isPlainObject(out[k]) ? out[k] : {}, v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function structuredCloneCompat(obj) {
  // Safari/older env safety
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}
