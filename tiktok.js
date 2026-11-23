// TikTok for GitGit Studio (developers.tiktok.com app): Login Kit + Content Posting API (Direct Post).
//
// The owner connects a TikTok account once (Login with TikTok); tokens live in ~/.config/gitgit-studio/tiktok.json
// (mode 600, outside the repo) and are refreshed here. Every post is reviewed in the dashboard first, as TikTok's
// Direct Post guidelines require: preview, caption, privacy picked by hand from the creator's own options,
// interaction settings, commercial-content disclosure, then the owner presses Post.
// Until the app passes TikTok's audit, posts can only be private (SELF_ONLY).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY = process.env.TIKTOK_CLIENT_KEY || "";
const SECRET = process.env.TIKTOK_CLIENT_SECRET || "";
const REDIRECT = process.env.TIKTOK_REDIRECT_URI || "https://dashboard.gitgitmiko.my.id/agen/api/tiktok/callback";
const SCOPES = "user.info.basic,video.publish";
const API = "https://open.tiktokapis.com/v2";
const STORE_DIR = join(homedir(), ".config", "gitgit-studio");
const STORE = join(STORE_DIR, "tiktok.json");
// Videos offered for posting: Kai & Kak Ara episodes (later also the anime-parody remakes).
const RUNS = join(homedir(), "github-repos", "nostalgia-reels", "runs");
const RUN_RE = /^\d{8}-(stick|duo)-[a-z0-9-]+$/;
const states = new Map(); // OAuth state -> { exp, redirect }

// TikTok error codes worth explaining in plain words.
const HINTS = {
  unaudited_client_can_only_post_to_private_accounts: "App belum lolos audit TikTok: akun TikTok-nya harus diset PRIVAT dulu (TikTok > Pengaturan dan privasi > Privasi > Akun privat) dan video diposting sebagai \"Hanya saya\".",
  privacy_level_option_mismatch: "Tingkat privasi tidak diizinkan untuk akun ini atau app yang belum diaudit; pilih \"Hanya saya (privat)\".",
  spam_risk_too_many_posts: "Batas posting harian akun ini tercapai, coba lagi besok.",
  spam_risk_user_banned_from_posting: "Akun ini sedang diblokir TikTok untuk memposting.",
  reached_active_user_cap: "Kuota pengguna harian app (belum diaudit) tercapai, coba lagi besok.",
  access_token_invalid: "Izin TikTok tidak berlaku lagi, hubungkan ulang akunnya.",
  scope_not_authorized: "Izin posting belum diberikan, hubungkan ulang akun dan setujui semua izin.",
};

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function load() {
  try {
    return JSON.parse(await readFile(STORE, "utf8"));
  } catch {
    return { posts: {} };
  }
}

async function save(data) {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STORE, JSON.stringify(data, null, 1), { mode: 0o600 });
  await chmod(STORE, 0o600);
}

async function call(path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method: payload ? "POST" : "GET", headers, body: payload, signal: AbortSignal.timeout(30000) });
  const data = await res.json().catch(() => ({}));
  const code = data.error?.code ?? data.error;
  if (!res.ok || (code && code !== "ok")) {
    const hint = HINTS[code] ? `${HINTS[code]} ` : "";
    throw fail(res.status >= 400 ? res.status : 502, `${hint}(TikTok: ${code || res.status} ${data.error?.message || data.error_description || ""})`.trim());
  }
  return data;
}

export function configured() {
  return Boolean(KEY && SECRET);
}

// redirect: the callback registered in the TikTok app for the place the login started (dashboard or the
// GitGit Studio panel); the same one must be sent again when the code is exchanged.
export function loginUrl(redirect = REDIRECT) {
  if (!configured()) throw fail(503, "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET belum di-set di .env dashboard");
  const state = randomBytes(16).toString("hex");
  const now = Date.now();
  for (const [s, v] of states) if (v.exp < now) states.delete(s);
  states.set(state, { exp: now + 10 * 60 * 1000, redirect });
  const q = new URLSearchParams({ client_key: KEY, scope: SCOPES, response_type: "code", redirect_uri: redirect, state });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

function keepToken(data, t) {
  const now = Date.now();
  data.token = {
    access_token: t.access_token, refresh_token: t.refresh_token, open_id: t.open_id, scope: t.scope,
    expires_at: now + (t.expires_in || 0) * 1000, refresh_expires_at: now + (t.refresh_expires_in || 0) * 1000,
  };
}

export async function callback(params) {
  if (params.get("error")) throw fail(400, `Login TikTok dibatalkan: ${params.get("error_description") || params.get("error")}`);
  const state = params.get("state") || "";
  const pending = states.get(state);
  if (!pending || pending.exp < Date.now()) throw fail(400, "Sesi login TikTok kedaluwarsa, coba hubungkan lagi");
  states.delete(state);
  const t = await call("/oauth/token/", { form: {
    client_key: KEY, client_secret: SECRET, code: params.get("code") || "", grant_type: "authorization_code", redirect_uri: pending.redirect } });
  const data = await load();
  keepToken(data, t);
  data.user = await userInfo(t.access_token);
  data.connected_at = new Date().toISOString();
  await save(data);
  return data.user;
}

async function userInfo(token) {
  const r = await call("/user/info/?fields=open_id,avatar_url,display_name", { token });
  return r.data?.user || {};
}

async function accessToken(data) {
  if (!data.token?.access_token) throw fail(409, "Akun TikTok belum dihubungkan");
  if (data.token.expires_at - Date.now() > 5 * 60 * 1000) return data.token.access_token;
  if (data.token.refresh_expires_at < Date.now()) throw fail(401, "Izin TikTok sudah kedaluwarsa, hubungkan ulang akunnya");
  const t = await call("/oauth/token/", { form: {
    client_key: KEY, client_secret: SECRET, grant_type: "refresh_token", refresh_token: data.token.refresh_token } });
  keepToken(data, t);
  await save(data);
  return data.token.access_token;
}

async function creatorInfo(token) {
  const r = await call("/post/publish/creator_info/query/", { token, body: {} });
  return r.data || {};
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

const HASHTAGS = "#kaidankakara #komedianimasi #kakakadik #animasilucu #stickman #fyp";
// Approved videos go out at these times (WIB), at most one a day for a freshly connected account: TikTok flags new
// accounts that post a lot through an API as inauthentic, so the first two weeks stay gentle.
const SLOTS = (process.env.TIKTOK_SLOTS || "19:00,20:30,22:00").split(",").map((x) => x.trim()).filter((x) => /^\d\d:\d\d$/.test(x));
const WARMUP_DAYS = 14;
const DAY = 86400000;
const dayKey = (ts) => new Date(ts + 7 * 3600000).toISOString().slice(0, 10);
const slotTime = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+07:00`);

function dailyCap(data) {
  const since = Date.parse(data.connected_at || 0);
  return Date.now() - since < WARMUP_DAYS * DAY ? 1 : SLOTS.length;
}

function usedOn(data, day, except) {
  const times = [];
  for (const [id, p] of Object.entries(data.posts || {})) if (id !== except && p.status !== "FAILED" && dayKey(Date.parse(p.at)) === day) times.push(Date.parse(p.at));
  for (const [id, q] of Object.entries(data.scheduled || {})) if (id !== except && dayKey(q.at) === day) times.push(q.at);
  return times;
}

function nextSlot(data, except) {
  const cap = dailyCap(data), now = Date.now();
  for (let d = 0; d < 30; d++) {
    const day = dayKey(now + d * DAY);
    const used = usedOn(data, day, except);
    if (used.length >= cap) continue;
    for (const hhmm of SLOTS) {
      const t = slotTime(day, hhmm);
      if (t > now + 5 * 60000 && !used.includes(t)) return t;
    }
  }
  return null;
}

async function queue(data) {
  let names = [];
  try {
    names = (await readdir(RUNS)).filter((n) => RUN_RE.test(n) && existsSync(join(RUNS, n, "final.mp4")));
  } catch { /* no runs yet */ }
  names.sort().reverse();
  const out = [];
  for (const id of names.slice(0, 30)) {
    const s = await readJson(join(RUNS, id, "script.json"));
    const st = await stat(join(RUNS, id, "final.mp4"));
    const title = s.judul || id;
    const head = s.hook ? String(s.hook) : `${title.charAt(0).toUpperCase()}${title.slice(1)} 😂`;
    out.push({
      id, title, format: id.includes("-stick-") ? "stickman" : "format lama", size: st.size,
      caption: `${head}\n${s.caption || ""}`.trim() + `\n\n${HASHTAGS}`,
      post: data.posts?.[id] || null,
      scheduled: data.scheduled?.[id] ? new Date(data.scheduled[id].at).toISOString() : null,
    });
  }
  return out;
}

export async function tiktokStatus() {
  const data = await load();
  const next = nextSlot(data);
  const base = { configured: configured(), connected: Boolean(data.token?.access_token), user: data.user || null,
    slots: SLOTS, dailyCap: dailyCap(data), nextSlot: next ? new Date(next).toISOString() : null };
  if (!base.connected) return { ...base, queue: await queue(data) };
  let creator = null, creatorError = null;
  try {
    creator = await creatorInfo(await accessToken(data));
  } catch (e) {
    creatorError = e.message;
  }
  return { ...base, creator, creatorError, queue: await queue(data) };
}

export function videoPath(id) {
  if (!RUN_RE.test(String(id || ""))) throw fail(400, "ID video tidak valid");
  const p = join(RUNS, id, "final.mp4");
  if (!existsSync(p)) throw fail(404, "Video tidak ditemukan");
  return p;
}

// Direct Post with FILE_UPLOAD: init gives an upload URL, the file goes up in chunks of 5-64 MB (a smaller file
// in one piece), then TikTok processes it and the status endpoint reports PUBLISH_COMPLETE or FAILED.
export async function publish(id, input, fromSchedule = false) {
  const file = videoPath(id);
  const data = await load();
  if (!fromSchedule && usedOn(data, dayKey(Date.now()), id).length >= dailyCap(data)) {
    throw fail(429, `Batas ${dailyCap(data)} posting per hari untuk akun ini sudah tercapai (akun baru dibatasi ${WARMUP_DAYS} hari pertama); jadwalkan untuk slot berikutnya.`);
  }
  const token = await accessToken(data);
  const creator = await creatorInfo(token);
  const privacy = String(input.privacy_level || "");
  if (!creator.privacy_level_options?.includes(privacy)) throw fail(400, "Pilih tingkat privasi dari daftar yang diberikan TikTok");
  const title = String(input.title || "").slice(0, 2200);
  if (input.brand_content && privacy === "SELF_ONLY") throw fail(400, "Konten bermerek tidak boleh berstatus privat (Only me)");
  const size = (await stat(file)).size;
  const CHUNK = 10 * 1024 * 1024;
  const chunk = size <= 64 * 1024 * 1024 ? size : CHUNK;
  const count = size <= 64 * 1024 * 1024 ? 1 : Math.floor(size / CHUNK);
  const init = await call("/post/publish/video/init/", { token, body: {
    post_info: {
      title, privacy_level: privacy,
      disable_comment: !input.allow_comment || Boolean(creator.comment_disabled),
      disable_duet: !input.allow_duet || Boolean(creator.duet_disabled),
      disable_stitch: !input.allow_stitch || Boolean(creator.stitch_disabled),
      video_cover_timestamp_ms: 1500,
      brand_content_toggle: Boolean(input.brand_content), brand_organic_toggle: Boolean(input.brand_organic),
    },
    source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count },
  } });
  const { publish_id, upload_url } = init.data || {};
  if (!publish_id || !upload_url) throw fail(502, "TikTok tidak memberi alamat unggah");
  const fh = await open(file, "r");
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunk;
      const end = i === count - 1 ? size - 1 : start + chunk - 1;
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      const res = await fetch(upload_url, { method: "PUT", body: buf, signal: AbortSignal.timeout(300000), headers: {
        "Content-Type": "video/mp4", "Content-Length": String(buf.length), "Content-Range": `bytes ${start}-${end}/${size}` } });
      if (!res.ok && res.status !== 206) throw fail(502, `Unggah ke TikTok gagal (HTTP ${res.status})`);
    }
  } finally {
    await fh.close();
  }
  data.posts = data.posts || {};
  data.posts[id] = { publish_id, status: "PROCESSING_UPLOAD", privacy_level: privacy, title, at: new Date().toISOString() };
  await save(data);
  return data.posts[id];
}

export async function publishStatus(id) {
  const data = await load();
  const post = data.posts?.[id];
  if (!post?.publish_id) throw fail(404, "Video ini belum pernah diposting");
  const r = await call("/post/publish/status/fetch/", { token: await accessToken(data), body: { publish_id: post.publish_id } });
  const d = r.data || {};
  Object.assign(post, { status: d.status || post.status, fail_reason: d.fail_reason || null,
    post_ids: d.publicaly_available_post_id || d.publicly_available_post_id || post.post_ids || [], checked: new Date().toISOString() });
  await save(data);
  return post;
}

export async function disconnect() {
  const data = await load();
  if (data.token?.access_token) {
    try {
      await call("/oauth/revoke/", { form: { client_key: KEY, client_secret: SECRET, token: data.token.access_token } });
    } catch { /* already revoked on TikTok's side */ }
  }
  delete data.token;
  delete data.user;
  await save(data);
}

// ---------------------------------------------------------------- schedule: approve now, post at the next free slot
export async function schedule(id, input) {
  videoPath(id);
  const data = await load();
  const token = await accessToken(data);
  const creator = await creatorInfo(token);
  if (!creator.privacy_level_options?.includes(String(input.privacy_level || ""))) throw fail(400, "Pilih tingkat privasi dari daftar yang diberikan TikTok");
  if (input.brand_content && input.privacy_level === "SELF_ONLY") throw fail(400, "Konten bermerek tidak boleh berstatus privat (Only me)");
  const at = nextSlot(data, id);
  if (!at) throw fail(409, "Tidak ada slot kosong dalam 30 hari ke depan");
  data.scheduled = data.scheduled || {};
  data.scheduled[id] = { at, input, approved_at: new Date().toISOString() };
  await save(data);
  return { at: new Date(at).toISOString() };
}

export async function unschedule(id) {
  const data = await load();
  if (data.scheduled?.[id]) delete data.scheduled[id];
  await save(data);
}

let ticking = false;
async function tick() {
  if (ticking || !configured()) return;
  ticking = true;
  try {
    const data = await load();
    const due = Object.entries(data.scheduled || {}).filter(([, q]) => q.at <= Date.now());
    for (const [id, q] of due) {
      const fresh = await load();
      delete fresh.scheduled[id];  // taken off first, so a crash never posts it twice
      await save(fresh);
      try {
        await publish(id, q.input, true);
        console.log(`tiktok: ${id} diposting sesuai jadwal`);
      } catch (e) {
        const d = await load();
        d.posts = d.posts || {};
        d.posts[id] = { status: "FAILED", fail_reason: e.message, privacy_level: q.input.privacy_level, at: new Date().toISOString() };
        await save(d);
        console.error(`tiktok: ${id} gagal diposting: ${e.message}`);
      }
    }
    // follow up recent uploads until TikTok reports the final status
    for (const [id, p] of Object.entries((await load()).posts || {})) {
      if (p.publish_id && /^PROCESSING/.test(p.status) && Date.now() - Date.parse(p.at) < 2 * 3600000) {
        try { await publishStatus(id); } catch { /* try again next minute */ }
      }
    }
  } catch (e) {
    console.error("tiktok scheduler:", e.message);
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  setInterval(tick, 60000).unref();
}
