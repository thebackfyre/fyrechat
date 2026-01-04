/* ============================================================================
  FyreChat — assets/fyrechat.js

  Goals:
  - Load default config (assets/config/fyrechat.default.json) + URI overrides (deep merge)
  - Connect to Twitch IRC (anonymous)
  - Render message bubbles in a stack
  - Supports:
    * Twitch emotes (from IRC tags)   ✅
    * Twitch badges via CF Worker proxy ✅
    * 3rd-party emotes: BTTV + 7TV     ✅ (DOM-safe replacement)
  - Demo mode is a controlled test harness.

  Key stability rule:
  - Twitch emotes are injected first using IRC indices -> HTML
  - 3P emotes are injected AFTER that, but ONLY by walking TEXT NODES (TreeWalker),
    so we never corrupt existing <img> tags.

============================================================================ */
(() => {
  // ----------------------------
  // Helpers
  // ----------------------------
  const $ = (sel) => document.querySelector(sel);

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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

  function parseBool(v, fallback = false) {
    if (v == null) return fallback;
    const s = String(v).toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return fallback;
  }

  // Deep merge plain objects (arrays overwrite)
  function deepMerge(base, patch) {
    const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
    if (!patch || typeof patch !== "object") return out;

    for (const [k, v] of Object.entries(patch)) {
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        out[k] &&
        typeof out[k] === "object" &&
        !Array.isArray(out[k])
      ) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // ----------------------------
  // DOM refs
  // ----------------------------
  const $debug = $("#debug");
  const $stack = $("#stack");

  // ----------------------------
  // Config loading
  // ----------------------------
  const params = new URLSearchParams(location.search);

  function uriConfigPatch() {
    const patch = {};

    if (params.has("ch")) patch.channel = String(params.get("ch") || "").toLowerCase();
    if (params.has("max")) patch.max = clampInt(params.get("max"), 8, 1, 200);
    if (params.has("ttl")) patch.ttl = clampInt(params.get("ttl"), 22, 0, 3600);
    if (params.has("fade")) patch.fade = clampFloat(params.get("fade"), 2, 0, 30);
    if (params.has("debug")) patch.debug = parseBool(params.get("debug"), false);
    if (params.has("demo")) patch.demo = parseBool(params.get("demo"), false);
    if (params.has("demoBadges")) patch.demoBadges = parseBool(params.get("demoBadges"), false);

    // optional toggles
    if (params.has("badges")) patch.badges = { enabled: parseBool(params.get("badges"), true) };
    if (params.has("emotes")) patch.emotes = { enabled: parseBool(params.get("emotes"), true) };
    if (params.has("theme")) patch.theme = String(params.get("theme") || "");

    return patch;
  }

  async function loadDefaultConfig() {
    // NOTE: fetch relative to fyrechat.html (works on GH Pages)
    const url = new URL("./assets/config/fyrechat.default.json", location.href).toString();
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
      const json = await res.json();
      return json && typeof json === "object" ? json : {};
    } catch (e) {
      console.warn("[FyreChat] Failed to load default config:", e);
      return {};
    }
  }

  // ----------------------------
  // Badge system (Twitch badge proxy)
  // ----------------------------
  const badgeState = {
    enabled: true,
    proxyBase: "",
    mergedLookup: null, // { set_id: { version: url1x } }
    channelId: null,
    lastError: null,
  };

  // The proxy can return two shapes; normalize both.
  function normalizeBadgePayload(payload) {
    // A) legacy badges.twitch.tv shape
    // { badge_sets: { set: { versions: { "1": { image_url_1x... } } } } }
    if (payload && payload.badge_sets) {
      const out = {};
      for (const [setId, setObj] of Object.entries(payload.badge_sets)) {
        const versions = setObj?.versions || {};
        out[setId] = {};
        for (const [ver, vObj] of Object.entries(versions)) {
          const url = vObj?.image_url_1x || vObj?.image_url_2x || vObj?.image_url_4x;
          if (url) out[setId][ver] = url;
        }
      }
      return out;
    }

    // B) helix-style wrapper used by your worker:
    // { data: [ { set_id, versions:[{id,image_url_1x...}] } ] }
    if (payload && Array.isArray(payload.data)) {
      const out = {};
      for (const set of payload.data) {
        const setId = set?.set_id;
        if (!setId) continue;
        out[setId] = {};
        const versions = Array.isArray(set.versions) ? set.versions : [];
        for (const v of versions) {
          const ver = String(v?.id ?? "");
          const url = v?.image_url_1x || v?.image_url_2x || v?.image_url_4x;
          if (ver && url) out[setId][ver] = url;
        }
      }
      return out;
    }

    return null;
  }

  function parseBadgeTag(badgesTag) {
    // e.g. "moderator/1,subscriber/6"
    if (!badgesTag || badgesTag === "(none)") return [];
    return String(badgesTag)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((pair) => {
        const [setId, ver] = pair.split("/");
        return { setId, ver };
      })
      .filter((b) => b.setId && b.ver);
  }

  function badgeUrlsFromTag(badgesTag) {
    const lookup = badgeState.mergedLookup;
    if (!lookup) return [];
    const want = parseBadgeTag(badgesTag);
    const urls = [];
    for (const b of want) {
      const set = lookup[b.setId];
      const url = set ? set[b.ver] : null;
      if (url) urls.push(url);
    }
    return urls;
  }

  async function fetchBadgeSets(proxyBase, channelId) {
    // endpoints your worker provides:
    // /badges/global
    // /badges/channels/:id
    const globalUrl = `${proxyBase.replace(/\/$/, "")}/badges/global`;
    const channelUrl = channelId
      ? `${proxyBase.replace(/\/$/, "")}/badges/channels/${encodeURIComponent(channelId)}`
      : null;

    const out = { global: null, channel: null };

    const [g, c] = await Promise.allSettled([
      fetch(globalUrl, { cache: "no-store" }),
      channelUrl ? fetch(channelUrl, { cache: "no-store" }) : Promise.resolve(null),
    ]);

    if (g.status === "fulfilled" && g.value?.ok) {
      const json = await g.value.json();
      out.global = normalizeBadgePayload(json);
    }
    if (c.status === "fulfilled" && c.value?.ok) {
      const json = await c.value.json();
      out.channel = normalizeBadgePayload(json);
    }

    return out;
  }

  async function resolveChannelId(proxyBase, login) {
    // You said your worker has an ID endpoint that works.
    // We try two common shapes so you can change server-side without touching client.
    const base = proxyBase.replace(/\/$/, "");
    const tries = [
      `${base}/id/${encodeURIComponent(login)}`,
      `${base}/id?login=${encodeURIComponent(login)}`,
      `${base}/id?channel=${encodeURIComponent(login)}`,
    ];

    for (const url of tries) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const json = await res.json();
        const id =
          json?.id ||
          json?.data?.id ||
          (Array.isArray(json?.data) ? json.data[0]?.id : null);
        if (id) return String(id);
      } catch {
        // keep trying
      }
    }
    return null;
  }

  // ----------------------------
  // 3P Emote system (BTTV + 7TV)
  // ----------------------------
  const emoteState = {
    enabled: true,
    map: null, // { CODE: { url, provider } }
    count: 0,
    lastError: null,
  };

  function nowMs() {
    return Date.now();
  }

  // cache in localStorage (simple)
  function cacheGet(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }

  function cacheSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }

  function buildBttvUrl(id) {
    return `https://cdn.betterttv.net/emote/${id}/1x`;
  }

  function build7tvUrl(hostUrl, fileName) {
    // 7TV gives host.url + files[]; 1x is usually "1x.webp" etc.
    // We choose the smallest/first file if present.
    if (!hostUrl) return null;
    if (fileName) return `${hostUrl}/${fileName}`;
    return null;
  }

  async function fetchBttvEmotes(channelId) {
    const out = [];

    // globals
    const g = await fetch("https://api.betterttv.net/3/cached/emotes/global", { cache: "no-store" });
    if (g.ok) {
      const arr = await g.json();
      for (const e of arr || []) {
        if (e?.code && e?.id) out.push({ code: e.code, url: buildBttvUrl(e.id), provider: "bttv" });
      }
    }

    // channel (requires Twitch channel ID)
    if (channelId) {
      const c = await fetch(
        `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(channelId)}`,
        { cache: "no-store" }
      );
      if (c.ok) {
        const json = await c.json();
        const channelEmotes = json?.channelEmotes || [];
        const sharedEmotes = json?.sharedEmotes || [];
        for (const e of [...channelEmotes, ...sharedEmotes]) {
          if (e?.code && e?.id) out.push({ code: e.code, url: buildBttvUrl(e.id), provider: "bttv" });
        }
      }
    }

    return out;
  }

  async function fetch7tvEmotes(channelId, baseUrl) {
    const out = [];
    const api = baseUrl || "https://api.7tv.app/v3";

    // globals are an emote set
    const g = await fetch(`${api}/emote-sets/global`, { cache: "no-store" });
    if (g.ok) {
      const set = await g.json();
      const emotes = set?.emotes || [];
      for (const e of emotes) {
        const name = e?.name;
        const host = e?.data?.host;
        const hostUrl = host?.url ? `https:${host.url}` : null;
        const files = Array.isArray(host?.files) ? host.files : [];
        const file = files.find((f) => String(f?.name || "").includes("1x")) || files[0];
        const url = build7tvUrl(hostUrl, file?.name);
        if (name && url) out.push({ code: name, url, provider: "7tv" });
      }
    }

    // channel: user lookup -> emote_set
    if (channelId) {
      const u = await fetch(`${api}/users/twitch/${encodeURIComponent(channelId)}`, { cache: "no-store" });
      if (u.ok) {
        const user = await u.json();
        const set = user?.emote_set;
        const emotes = set?.emotes || [];
        for (const e of emotes) {
          const name = e?.name;
          const host = e?.data?.host;
          const hostUrl = host?.url ? `https:${host.url}` : null;
          const files = Array.isArray(host?.files) ? host.files : [];
          const file = files.find((f) => String(f?.name || "").includes("1x")) || files[0];
          const url = build7tvUrl(hostUrl, file?.name);
          if (name && url) out.push({ code: name, url, provider: "7tv" });
        }
      }
    }

    return out;
  }

  function emoteImgHtml(url) {
    // reuse your CSS .emote
    return `<img class="emote" alt="" src="${url}">`;
  }

  // IMPORTANT:
  // Replace emotes ONLY within TEXT nodes (so we never break existing HTML / <img> tags)
  // Handles edge cases:
  //  - punctuation: "widepeepoHappy!" , "PepeLaugh," , "monkaS..."
  //  - angle brackets: "<widepeepoHappy>"
  function apply3PEmotesToElement(rootEl, emoteMap) {
    if (!rootEl || !emoteMap) return;

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    for (const node of textNodes) {
      const original = node.nodeValue;
      if (!original || !original.trim()) continue;

      // Fast precheck: if no word-ish tokens, skip
      // (This is cheap; avoids work in busy chat)
      if (!/[A-Za-z0-9_]/.test(original)) continue;

      const frag = document.createDocumentFragment();
      let changed = false;

      // split but keep whitespace
      const parts = original.split(/(\s+)/);

      for (const part of parts) {
        if (!part) continue;

        // keep whitespace intact
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }

        // leading/trailing punctuation buckets
        // NOTE: allow emote codes like "OMEGALUL", "widepeepoHappy", "monkaS"
        // We treat "word-ish" as [A-Za-z0-9_]+ (most emote codes)
        const m = part.match(/^([^A-Za-z0-9_]*)([A-Za-z0-9_]+)([^A-Za-z0-9_]*)$/);

        if (!m) {
          // not a simple token -> keep as text
          frag.appendChild(document.createTextNode(part));
          continue;
        }

        const lead = m[1] || "";
        const core = m[2] || "";
        const tail = m[3] || "";

        const hit = emoteMap[core];

        if (!hit || !hit.url) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }

        changed = true;

        if (lead) frag.appendChild(document.createTextNode(lead));

        const img = document.createElement("img");
        img.className = "emote";
        img.alt = "";
        img.src = hit.url;
        frag.appendChild(img);

        if (tail) frag.appendChild(document.createTextNode(tail));
      }

      if (changed) node.parentNode.replaceChild(frag, node);
    }
  }

  async function load3PEmoteMap(cfg, channelId) {
    const enabled = !!cfg?.emotes?.enabled;
    if (!enabled) {
      emoteState.map = null;
      emoteState.count = 0;
      return;
    }

    const providers = cfg?.emotes?.providers || {};
    const bttvOn = !!providers?.bttv?.enabled;
    const sevenOn = !!providers?.["7tv"]?.enabled;
    const sevenBase = providers?.["7tv"]?.baseUrl || "https://api.7tv.app/v3";
    const cacheMinutes = clampInt(cfg?.emotes?.cacheMinutes, 360, 1, 10080);

    const cacheKey = `fyrechat_emotes_${cfg.channel || "unknown"}_${channelId || "noid"}`;
    const cached = cacheGet(cacheKey);

    if (cached?.ts && cached?.map && typeof cached.map === "object") {
      const ageMin = (nowMs() - cached.ts) / 60000;
      if (ageMin <= cacheMinutes) {
        emoteState.map = cached.map;
        emoteState.count = cached.count || Object.keys(cached.map).length;
        emoteState.lastError = null;
        return;
      }
    }

    try {
      const lists = [];

      if (bttvOn) lists.push(fetchBttvEmotes(channelId));
      if (sevenOn) lists.push(fetch7tvEmotes(channelId, sevenBase));

      const settled = await Promise.allSettled(lists);

      const merged = {};
      let count = 0;

      for (const s of settled) {
        if (s.status !== "fulfilled") continue;
        for (const e of s.value || []) {
          if (!e?.code || !e?.url) continue;
          // First win keeps it stable if duplicates exist.
          if (!merged[e.code]) {
            merged[e.code] = { url: e.url, provider: e.provider || "3p" };
            count++;
          }
        }
      }

      emoteState.map = merged;
      emoteState.count = count;
      emoteState.lastError = null;

      cacheSet(cacheKey, { ts: nowMs(), map: merged, count });

    } catch (e) {
      emoteState.lastError = String(e?.message || e);
      emoteState.map = null;
      emoteState.count = 0;
    }
  }

  // ----------------------------
  // Twitch emotes (IRC "emotes" tag)
  // ----------------------------
  function buildTwitchEmoteHtmlParts(text, emotesTag) {
    if (!emotesTag) return [escapeHtml(text)];

    // Build ranges: [{start,end,id}]
    const ranges = [];
    for (const def of String(emotesTag).split("/").filter(Boolean)) {
      const [id, locs] = def.split(":");
      if (!id || !locs) continue;
      for (const loc of locs.split(",")) {
        const [startStr, endStr] = loc.split("-");
        const start = Number(startStr);
        const end = Number(endStr);
        if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end, id });
      }
    }

    if (!ranges.length) return [escapeHtml(text)];
    ranges.sort((a, b) => a.start - b.start);

    const parts = [];
    let cursor = 0;

    for (const r of ranges) {
      if (r.start > cursor) parts.push(escapeHtml(text.slice(cursor, r.start)));

      // twitch emote url
      parts.push(
        `<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`
      );

      cursor = r.end + 1;
    }

    if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
    return parts;
  }

  // ----------------------------
  // IRC
  // ----------------------------
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
    const badges = tags["badges"] || "(none)";

    return { name, color, text, emotes, badges };
  }

  function connectIrc(cfg) {
    const chan = (cfg.channel || "alveussanctuary").toLowerCase();
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

    ws.addEventListener("open", () => {
      if (cfg.debug && $debug) {
        $debug.style.display = "block";
        $debug.textContent = `Connected ✅ as ${anonNick} (joining #${chan})`;
      }
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send("NICK " + anonNick);
      ws.send("JOIN #" + chan);
    });

    ws.addEventListener("message", (ev) => {
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

        const htmlParts = buildTwitchEmoteHtmlParts(parsed.text, parsed.emotes);
        const badgeImgs = cfg.badges?.enabled ? badgeUrlsFromTag(parsed.badges) : [];

        addMessage(cfg, parsed.name, parsed.color, htmlParts, badgeImgs);
      }
    });

    ws.addEventListener("close", () => {
      if (cfg.debug && $debug) $debug.textContent = "Disconnected — retrying in 2s…";
      setTimeout(() => connectIrc(cfg), 2000);
    });

    ws.addEventListener("error", () => {
      if (cfg.debug && $debug) $debug.textContent = "WebSocket error (network/CSP).";
    });
  }

  // ----------------------------
  // Rendering
  // ----------------------------
  function addMessage(cfg, name, color, htmlParts, badgeImgs) {
    if (!$stack) return;

    const max = clampInt(cfg.max, 8, 1, 200);
    const ttlSeconds = clampInt(cfg.ttl, 22, 0, 3600);
    const fadeSeconds = clampFloat(cfg.fade, 2, 0, 30);

    const el = document.createElement("div");
    el.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";

    // badges (images) BEFORE name
    if (Array.isArray(badgeImgs) && badgeImgs.length) {
      for (const url of badgeImgs) {
        const img = document.createElement("img");
        img.className = "badge";
        img.alt = "";
        img.src = url;
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

    // Apply 3P emotes safely (only text nodes)
    try {
      if (cfg.emotes?.enabled && emoteState.map) {
        apply3PEmotesToElement(textEl, emoteState.map);
      }
    } catch (e) {
      // never let emotes break the render path
      if (cfg.debug && $debug) $debug.textContent = `3P emote error: ${String(e?.message || e)}`;
    }

    meta.appendChild(nameEl);
    el.appendChild(meta);
    el.appendChild(textEl);

    $stack.appendChild(el);

    // Keep list tight
    while ($stack.children.length > max) $stack.removeChild($stack.firstChild);

    // TTL removal
    if (ttlSeconds > 0) {
      const removeAtMs = ttlSeconds * 1000;
      const fadeMs = Math.max(0, fadeSeconds * 1000);

      if (fadeMs > 0 && removeAtMs > fadeMs) {
        setTimeout(() => el.classList.add("out"), removeAtMs - fadeMs);
        setTimeout(() => el.remove(), removeAtMs);
      } else {
        setTimeout(() => el.remove(), removeAtMs);
      }
    }
  }

  // ----------------------------
  // Demo (controlled harness)
  // ----------------------------
  function runDemo(cfg) {
    // These test punctuation + < > + mixed providers.
    // NOTE: Twitch “global emotes” like Kappa only render as Twitch emotes in LIVE,
    // because Twitch emotes require the IRC 'emotes' tag indices.
    // Demo is for: badges + 3P parsing reliability + punctuation edge cases.

    const samples = [
      { name: "Fyre", color: "#9bf", text: "Badges before the name — baseline 👋" },
      { name: "ModUser", color: "#6f6", text: "Punct: PepeLaugh, monkaS... catJAM? widepeepoHappy!" },
      { name: "Viewer", color: "#fc6", text: "Angle: <widepeepoHappy> <catJAM> <PepeLaugh>" },
      { name: "Fyre", color: "#9bf", text: "MIX: PepeLaugh monkaS catJAM widepeepoHappy" },
      { name: "Viewer", color: "#fc6", text: "Spacing:   PepeLaugh   monkaS   catJAM   widepeepoHappy" },
    ];

    const demoBadges = [
      "broadcaster/1",
      "moderator/1,subscriber/6",
      "subscriber/3",
      "vip/1",
      "moderator/1",
    ];

    let i = 0;
    setInterval(() => {
      const s = samples[i % samples.length];

      const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";
      const badgeImgs = cfg.badges?.enabled ? badgeUrlsFromTag(badgeTag) : [];

      // In demo we pass plain text as escaped HTML (no Twitch emote indices here)
      addMessage(cfg, s.name, s.color, [escapeHtml(s.text)], badgeImgs);
      i++;
    }, 1100);
  }

  // ----------------------------
  // Theme
  // ----------------------------
  function applyTheme(cfg) {
    const theme = String(cfg.theme || "").trim();
    const link = document.getElementById("themeLink");
    if (!link || !theme) return;

    // expects assets/themes/<theme>.css
    link.setAttribute("href", `./assets/themes/${theme}.css`);
  }

  // ----------------------------
  // Boot
  // ----------------------------
  async function main() {
    const defaults = await loadDefaultConfig();
    const patch = uriConfigPatch();

    // Ensure structure exists even if config doesn't define them yet
    const base = deepMerge(
      {
        channel: "alveussanctuary",
        max: 8,
        ttl: 22,
        fade: 2,
        debug: false,
        demo: false,
        demoBadges: false,
        theme: "glass",
        badgeProxy: "",
        badges: { enabled: true },
        emotes: {
          enabled: true,
          providers: { bttv: { enabled: true }, "7tv": { enabled: true, baseUrl: "https://api.7tv.app/v3" } },
          cacheMinutes: 360,
        },
      },
      defaults
    );

    const cfg = deepMerge(base, patch);

    // Badge / emote enabled flags can live in cfg.badges + cfg.emotes
    badgeState.enabled = !!cfg.badges?.enabled;
    badgeState.proxyBase = String(cfg.badgeProxy || "").trim();
    emoteState.enabled = !!cfg.emotes?.enabled;

    applyTheme(cfg);

    // Resolve channel id (for channel badge sets + channel emotes)
    let channelId = null;
    if (badgeState.proxyBase) {
      channelId = await resolveChannelId(badgeState.proxyBase, cfg.channel);
      badgeState.channelId = channelId;
    }

    // Load badge sets
    let badgeSetsLoaded = false;
    if (badgeState.enabled && badgeState.proxyBase) {
      try {
        const sets = await fetchBadgeSets(badgeState.proxyBase, channelId);
        if (!sets.global) throw new Error("global badge_sets missing");
        const merged = { ...(sets.global || {}) };
        // channel overrides / adds
        if (sets.channel) {
          for (const [setId, versions] of Object.entries(sets.channel)) {
            merged[setId] = { ...(merged[setId] || {}), ...(versions || {}) };
          }
        }
        badgeState.mergedLookup = merged;
        badgeState.lastError = null;
        badgeSetsLoaded = true;
      } catch (e) {
        badgeState.lastError = String(e?.message || e);
        badgeState.mergedLookup = null;
      }
    }

    // Load 3P emotes
    await load3PEmoteMap(cfg, channelId);

    // Debug banner
    if (cfg.debug && $debug) {
      $debug.style.display = "block";

      const badgeInfo = badgeState.enabled ? "on" : "off";
      const emoteInfo = emoteState.enabled ? "on" : "off";

      const badgeSetsInfo = badgeSetsLoaded ? "on" : "off";
      const emoteCount = emoteState.count || 0;

      const errBits = [];
      if (badgeState.lastError) errBits.push(`badgeErr=${badgeState.lastError}`);
      if (emoteState.lastError) errBits.push(`emoteErr=${emoteState.lastError}`);

      $debug.textContent =
        `${cfg.demo ? "DEMO" : "IRC"} | ch=${cfg.channel} | max=${cfg.max} | ttl=${cfg.ttl}s | fade=${cfg.fade}s` +
        ` | badges=${badgeInfo} | emotes=${emoteInfo}` +
        ` | badgeSets=${badgeSetsInfo}, 3pEmotes=${emoteCount}` +
        (errBits.length ? ` | ${errBits.join(" | ")}` : "");
    }

    // Run
    if (cfg.demo) runDemo(cfg);
    else connectIrc(cfg);
  }

  main();
})();
