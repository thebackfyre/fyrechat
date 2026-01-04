/* =========================================================
   FyreChat - Overlay Chat Widget
   ========================================================= */

(() => {
  /* =========================
     Utilities
  ========================= */
  const $debug = document.getElementById("debug");
  const $stack = document.getElementById("stack");
  const params = new URLSearchParams(location.search);

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function clampInt(v, d, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function clampFloat(v, d, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.max(min, Math.min(max, n));
  }

  function deepMerge(base, patch) {
    if (typeof patch !== "object" || patch === null) return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = deepMerge(out[k] || {}, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function showDebug(text) {
    if (!$debug) return;
    $debug.style.display = "block";
    $debug.textContent = text;
  }

  /* =========================
     Defaults (baseline)
  ========================= */
  let config = {
    channel: "alveussanctuary",
    max: 8,
    ttlSeconds: 22,
    fadeSeconds: 2,
    debug: false,

    badgeProxy: "",
    badges: {
      enabled: true,
      showInDemo: false
    },

    demo: false,

    emotes: {
      enabled: true,
      cacheMinutes: 360,
      providers: {
        bttv: { enabled: true },
        "7tv": { enabled: true, baseUrl: "https://api.7tv.app/v3" }
      }
    }
  };

  let BADGE_PROXY_BASE = "";

  /* =========================
     Boot
  ========================= */
  boot().catch(err => {
    showDebug(`BOOT ERROR: ${err.message || err}`);
  });

  async function boot() {
    const cfgUrl =
      params.get("cfg") ||
      "./assets/config/fyrechat.default.json";

    let cfgLoaded = false;

    try {
      const cfg = await fetchJson(cfgUrl);
      config = deepMerge(config, cfg);
      cfgLoaded = true;
    } catch (e) {
      showDebug(`CONFIG LOAD FAILED: ${cfgUrl}`);
    }

    // URI overrides (last wins)
    if (params.has("ch")) config.channel = params.get("ch").toLowerCase();
    config.max = clampInt(params.get("max"), config.max, 1, 200);
    config.ttlSeconds = clampInt(params.get("ttl"), config.ttlSeconds, 0, 3600);
    config.fadeSeconds = clampFloat(params.get("fade"), config.fadeSeconds, 0, 30);
    config.debug = params.get("debug") === "1" || config.debug;
    config.demo = params.get("demo") === "1";

    if (config.badgeProxy) {
      BADGE_PROXY_BASE = config.badgeProxy.replace(/\/+$/, "");
    }

    if (config.debug) {
      showDebug(
        `cfg=${cfgLoaded ? "OK" : "FAIL"} | ` +
        `ch=${config.channel} | max=${config.max} | ` +
        `badges=${config.badges.enabled ? "on" : "off"} | ` +
        `emotes=${config.emotes.enabled ? "on" : "off"}`
      );
    }

    if (config.demo) runDemo();
    else connectIrc(config.channel);
  }

  /* =========================
     Demo
  ========================= */
  function runDemo() {
    const samples = [
      { name: "Fyre", color: "#9bf", text: "FyreChat demo 👋" },
      { name: "Viewer", color: "#fc6", text: "BTTV & 7TV emotes will render here" }
    ];
    let i = 0;
    setInterval(() => {
      const s = samples[i++ % samples.length];
      addMessage({
        name: s.name,
        color: s.color,
        htmlParts: applyThirdPartyEmotes([escapeHtml(s.text)]),
        badges: []
      });
    }, 1200);
  }

  /* =========================
     IRC
  ========================= */
  const emoteState = { ready: false, map: new Map(), channelId: null };
  const badgeState = { ready: false, global: null, channel: null, channelId: null };

  function connectIrc(chan) {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const nick = "justinfan" + Math.floor(Math.random() * 90000);

    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags");
      ws.send("PASS SCHMOOPIIE");
      ws.send("NICK " + nick);
      ws.send("JOIN #" + chan);
    };

    ws.onmessage = async ev => {
      const msg = ev.data;
      if (msg.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv");
        return;
      }

      for (const line of msg.split("\r\n")) {
        if (!line.includes("PRIVMSG")) continue;

        const parsed = parsePrivmsg(line);
        if (!parsed) continue;

        const roomId = parsed.tags["room-id"];

        if (roomId && !emoteState.channelId && config.emotes.enabled) {
          emoteState.channelId = roomId;
          initThirdPartyEmotes(roomId);
        }

        if (roomId && !badgeState.channelId && config.badges.enabled) {
          badgeState.channelId = roomId;
          initBadges(roomId);
        }

        addMessage({
          name: parsed.name,
          color: parsed.color,
          htmlParts: applyThirdPartyEmotes(parsed.htmlParts),
          badges: buildBadges(parsed.tags)
        });
      }
    };
  }

  function parsePrivmsg(line) {
    let tags = {};
    let rest = line;

    if (rest.startsWith("@")) {
      const idx = rest.indexOf(" ");
      tags = Object.fromEntries(rest.slice(1, idx).split(";").map(p => p.split("=")));
      rest = rest.slice(idx + 1);
    }

    const msgIdx = rest.indexOf(" :");
    if (msgIdx === -1) return null;

    const text = rest.slice(msgIdx + 2);
    const name = tags["display-name"] || "User";
    const color = tags["color"] || "#fff";
    const emotes = tags["emotes"] || "";

    return {
      name,
      color,
      tags,
      htmlParts: buildTwitchEmotes(text, emotes)
    };
  }

  function buildTwitchEmotes(text, emotesTag) {
    if (!emotesTag) return [escapeHtml(text)];
    const ranges = [];
    emotesTag.split("/").forEach(e => {
      const [id, locs] = e.split(":");
      locs?.split(",").forEach(loc => {
        const [s, e] = loc.split("-").map(Number);
        ranges.push({ s, e, id });
      });
    });

    ranges.sort((a,b) => a.s - b.s);
    let out = [], i = 0;

    for (const r of ranges) {
      if (r.s > i) out.push(escapeHtml(text.slice(i, r.s)));
      out.push(`<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`);
      i = r.e + 1;
    }
    if (i < text.length) out.push(escapeHtml(text.slice(i)));
    return out;
  }

  /* =========================
     BTTV + 7TV
  ========================= */
  async function initThirdPartyEmotes(channelId) {
    if (emoteState.ready) return;
    const items = [];

    if (config.emotes.providers.bttv.enabled) {
      try {
        const g = await fetchJson("https://api.betterttv.net/3/cached/emotes/global");
        g.forEach(e => items.push({ token: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x` }));
        const c = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
        [...(c.channelEmotes||[]),(c.sharedEmotes||[])].flat()
          .forEach(e => items.push({ token: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x` }));
      } catch {}
    }

    if (config.emotes.providers["7tv"].enabled) {
      try {
        const u = await fetchJson(`${config.emotes.providers["7tv"].baseUrl}/users/twitch/${channelId}`);
        u.emote_set?.emotes?.forEach(e => {
          const f = e.data.host.files.find(f => f.name.includes("1x")) || e.data.host.files[0];
          items.push({ token: e.name, url: `https:${e.data.host.url}/${f.name}` });
        });
      } catch {}
    }

    items.forEach(e => emoteState.map.set(e.token, e.url));
    emoteState.ready = true;
  }

  function applyThirdPartyEmotes(parts) {
    if (!emoteState.ready) return parts;
    return parts.map(p =>
      p.includes("<img") ? p :
      p.replace(/\S+/g, t => emoteState.map.has(t)
        ? `<img class="emote" src="${emoteState.map.get(t)}">`
        : t
      )
    );
  }

  /* =========================
     Badges
  ========================= */
  async function initBadges(channelId) {
    try {
      badgeState.global = await fetchJson(`${BADGE_PROXY_BASE}/badges/global`);
      badgeState.channel = await fetchJson(`${BADGE_PROXY_BASE}/badges/channels/${channelId}`);
      badgeState.ready = true;
    } catch {}
  }

  function buildBadges(tags) {
    if (!badgeState.ready) return [];
    const badgeStr = tags["badges"];
    if (!badgeStr) return [];

    return badgeStr.split(",").map(b => {
      const [set, ver] = b.split("/");
      return (
        badgeState.channel?.badge_sets?.[set]?.versions?.[ver] ||
        badgeState.global?.badge_sets?.[set]?.versions?.[ver]
      );
    }).filter(Boolean).map(b => ({
      title: b.title,
      url: b.image_url_1x
    }));
  }

  /* =========================
     Render
  ========================= */
  function addMessage({ name, color, htmlParts, badges }) {
    const el = document.createElement("div");
    el.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";

    badges?.forEach(b => {
      const img = document.createElement("img");
      img.className = "badge";
      img.src = b.url;
      meta.appendChild(img);
    });

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.style.color = color;
    nameEl.textContent = name;

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.innerHTML = htmlParts.join("");

    meta.appendChild(nameEl);
    el.appendChild(meta);
    el.appendChild(textEl);
    $stack.appendChild(el);

    while ($stack.children.length > config.max) {
      $stack.removeChild($stack.firstChild);
    }

    if (config.ttlSeconds > 0) {
      const t = config.ttlSeconds * 1000;
      const f = config.fadeSeconds * 1000;
      if (f && t > f) {
        setTimeout(() => el.classList.add("out"), t - f);
      }
      setTimeout(() => el.remove(), t);
    }
  }

})();
