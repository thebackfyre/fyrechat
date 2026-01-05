import { STATE } from "./state.js";
import { escapeHtml, escapeAttr } from "./utils.js";

export function initRenderDom() {
  STATE.$stack = document.getElementById("stack");
}

export function addMessage(cfg, name, color, htmlParts, badgeImgs = []) {
  const $stack = STATE.$stack;
  if (!$stack) return;

  const el = document.createElement("div");
  el.className = "msg";

  const meta = document.createElement("div");
  meta.className = "meta";

  // badges
  if (badgeImgs && badgeImgs.length) {
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
  textEl.innerHTML = htmlParts.join("");

  meta.appendChild(nameEl);
  el.appendChild(meta);
  el.appendChild(textEl);

  $stack.appendChild(el);

  // keep list tight
  while ($stack.children.length > cfg.max) $stack.removeChild($stack.firstChild);

  // TTL removal
  if (cfg.ttl > 0) {
    const removeAtMs = cfg.ttl * 1000;
    const fadeMs = Math.max(0, cfg.fade * 1000);

    if (fadeMs > 0 && removeAtMs > fadeMs) {
      setTimeout(() => el.classList.add("out"), removeAtMs - fadeMs);
      setTimeout(() => el.remove(), removeAtMs);
    } else {
      setTimeout(() => el.remove(), removeAtMs);
    }
  }
}

// Twitch emotes from IRC emotes tag + 3P in text segments
export function buildMessageHtmlParts(text, emotesTag) {
  if (!emotesTag) return [renderTextWith3PEmotes(text)];

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

  if (!ranges.length) return [renderTextWith3PEmotes(text)];
  ranges.sort((a, b) => a.start - b.start);

  const parts = [];
  let cursor = 0;

  for (const r of ranges) {
    if (r.start > cursor) {
      parts.push(renderTextWith3PEmotes(text.slice(cursor, r.start)));
    }
    parts.push(
      `<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`
    );
    cursor = r.end + 1;
  }

  if (cursor < text.length) {
    parts.push(renderTextWith3PEmotes(text.slice(cursor)));
  }

  return parts;
}

export function renderTextWith3PEmotes(rawText) {
  const escaped = escapeHtml(rawText);

  const cfg = STATE.cfg;

  // FIX: support both cfg.emotes === true (boolean) and cfg.emotes.enabled === true (object)
  const emotesEnabled = (() => {
    const v = cfg?.emotes;
    if (v === true) return true;
    if (v && typeof v === "object") return !!v.enabled;
    // also tolerate common string forms if you ever pass through raw query values
    if (v === "1" || v === "true" || v === "on") return true;
    return false;
  })();

  if (!emotesEnabled || !STATE.emotesReady || STATE.emoteMap3P.size === 0) return escaped;

  const tokens = escaped.split(/(\s+)/);
  const TRAIL_PUNCT = /[!?.,:;~]+$/;

  function peelToken(tok) {
const LEFT_SEQ = ["(", "[", "{", "<", "&lt;", '"', "&#039;"];
const RIGHT_SEQ = [")", "]", "}", ">", "&gt;", '"', "&#039;"];


    let left = "";
    let right = "";
    let core = tok;

    // peel trailing punctuation first (so &gt; stays attached to core until bracket-peel)
    let punct = "";
    const pm = core.match(TRAIL_PUNCT);
    if (pm) {
      punct = pm[0];
      core = core.slice(0, -punct.length);
    }

    let changed = true;
    while (changed && core.length) {
      changed = false;

      for (const seq of LEFT_SEQ) {
        if (core.startsWith(seq)) {
          left += seq;
          core = core.slice(seq.length);
          changed = true;
          break;
        }
      }

      for (const seq of RIGHT_SEQ) {
        if (core.endsWith(seq)) {
          right = seq + right;
          core = core.slice(0, -seq.length);
          changed = true;
          break;
        }
      }
    }

    right = right + punct;
    return { left, core, right };
  }

  const out = tokens.map((tok) => {
    if (!tok || /^\s+$/.test(tok)) return tok;

    const { left, core, right } = peelToken(tok);
    if (!core) return tok;

    // primary lookup
    let em = STATE.emoteMap3P.get(core);

    // optional fallback: case-insensitive match if your map stores normalized keys
    if (!em) em = STATE.emoteMap3P.get(core.toLowerCase());

    if (!em) return tok;

    return `${left}<img class="emote" alt="" src="${escapeAttr(em.url)}">${right}`;
  });

  return out.join("");
}
