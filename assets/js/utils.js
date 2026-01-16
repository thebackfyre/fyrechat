export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

export function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

export function escapeAttr(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

export function structuredCloneSafe(obj) {
  try { return structuredClone(obj); }
  catch { return JSON.parse(JSON.stringify(obj)); }
}

export function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(target, source) {
  if (!isObj(target) || !isObj(source)) return source;

  const out = Array.isArray(target) ? target.slice() : { ...target };

  for (const [k, v] of Object.entries(source)) {
    if (Array.isArray(v)) {
      out[k] = v.slice();
    } else if (isObj(v)) {
      out[k] = deepMerge(isObj(out[k]) ? out[k] : {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}
