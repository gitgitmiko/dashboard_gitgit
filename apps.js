// Tab "Apps and Games": status aplikasi milik sendiri dan kartu Info developer (Firestore announcements/).
// Draf kartu ditulis Claude CLI dari commit sejak kartu terakhir; posting memakai login firebase-tools di server.
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOME = homedir();
const CLAUDE_BIN = process.env.CLAUDE_BIN || join(HOME, ".local/bin/claude");
// Klien OAuth publik firebase-tools (sama seperti tools/post_announcement.py di valoid-mobile).
const FIREBASE_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";
const TYPES = new Set(["update", "bugfix", "info"]);

export const APPS = [
  {
    id: "valoid",
    name: "Valoid Hub",
    platform: "Android · Google Play",
    packageName: "com.valoid.mobile",
    repo: join(HOME, "github-repos/valoid-mobile"),
    gradle: "app/build.gradle.kts",
    icon: "docs/icon/valoid-icon-playstore-512.png",
    firebaseProject: "valoid-d04fc",
  },
];

function appById(id) {
  const app = APPS.find((a) => a.id === id);
  if (!app) throw Object.assign(new Error("Aplikasi tidak dikenal"), { status: 404 });
  return app;
}

async function readVersion(app) {
  const text = await readFile(join(app.repo, app.gradle), "utf8");
  return {
    versionName: /versionName\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null,
    versionCode: Number(/versionCode\s*=\s*(\d+)/.exec(text)?.[1]) || null,
  };
}

// ---------- Firestore ----------

let cachedToken = { value: null, expires: 0 };

async function accessToken() {
  if (cachedToken.value && Date.now() < cachedToken.expires) return cachedToken.value;
  const cfg = JSON.parse(await readFile(join(HOME, ".config/configstore/firebase-tools.json"), "utf8"));
  const refresh = cfg?.tokens?.refresh_token;
  if (!refresh) throw new Error("Login firebase-tools tidak ditemukan di server (jalankan firebase login)");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: FIREBASE_CLIENT_ID, client_secret: FIREBASE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refresh }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token Firebase gagal: ${data.error_description || data.error || res.status}`);
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in - 120) * 1000 };
  return cachedToken.value;
}

async function firestore(app, method, path = "", body) {
  const url = `https://firestore.googleapis.com/v1/projects/${app.firebaseProject}/databases/(default)/documents/announcements${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${data.error?.message || "gagal"}`);
  return data;
}

function parseDoc(doc) {
  const f = doc.fields || {};
  return {
    id: doc.name.split("/").pop(),
    title: f.title?.stringValue ?? "",
    body: f.body?.stringValue ?? "",
    type: f.type?.stringValue ?? "info",
    version: f.version?.stringValue ?? null,
    publishedAt: f.publishedAt?.timestampValue ?? null,
  };
}

async function listAnnouncements(app) {
  const data = await firestore(app, "GET", "?pageSize=50");
  return (data.documents || []).map(parseDoc).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

// ---------- Git ----------

const SEP = "\x1f";
const END = "\x1e";

async function commitsSince(app, sinceIso) {
  const args = ["-C", app.repo, "log", "--no-merges", `--pretty=format:%h${SEP}%cI${SEP}%s${SEP}%b${END}`, "-n", "60"];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  const { stdout } = await run("git", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout
    .split(END)
    .map((s) => s.replace(/^\n/, ""))
    .filter(Boolean)
    .map((line) => {
      const [hash, date, subject, body] = line.split(SEP);
      const kind = /^(\w+)(\(.+\))?!?:/.exec(subject)?.[1] ?? "other";
      const cleanBody = (body || "").replace(/^Co-Authored-By:.*$/gim, "").trim();
      // feat/fix terasa oleh pengguna; chore/build/docs/test/refactor biasanya tidak.
      return { hash, date, subject, body: cleanBody, kind, userFacing: kind === "feat" || kind === "fix" };
    });
}

export async function appsStatus() {
  return Promise.all(
    APPS.map(async (app) => {
      const [version, announcements] = await Promise.all([readVersion(app), listAnnouncements(app).catch((e) => ({ error: e.message }))]);
      const list = Array.isArray(announcements) ? announcements : [];
      const last = list[0] || null;
      const commits = await commitsSince(app, last?.publishedAt);
      return {
        id: app.id,
        name: app.name,
        platform: app.platform,
        packageName: app.packageName,
        ...version,
        announcements: list,
        announcementsError: Array.isArray(announcements) ? null : announcements.error,
        lastAnnouncement: last,
        commits,
      };
    }),
  );
}

export async function appIcon(id) {
  const app = appById(id);
  return readFile(join(app.repo, app.icon));
}

// ---------- Draf dengan Claude ----------

function claudeJson(prompt, cwd, timeoutMs = 150_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "text"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude terlalu lama menjawab"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `Claude keluar dengan kode ${code}`));
      const match = /\{[\s\S]*\}/.exec(out);
      if (!match) return reject(new Error("Jawaban Claude bukan JSON"));
      try {
        resolve(JSON.parse(match[0]));
      } catch {
        reject(new Error("JSON dari Claude tidak valid"));
      }
    });
    child.stdin.end(prompt);
  });
}

function fallbackDraft(app, version, commits) {
  const picked = commits.filter((c) => c.userFacing);
  const lines = (picked.length ? picked : commits).map((c) => "• " + c.subject.replace(/^\w+(\(.+\))?!?:\s*/, "").replace(/;\s*versi.*$/i, ""));
  return {
    type: picked.some((c) => c.kind === "feat") ? "update" : picked.length ? "bugfix" : "info",
    title: `Pembaruan ${app.name} ${version.versionName ?? ""}`.trim(),
    body: lines.join("\n") || "Perbaikan kecil dan peningkatan performa.",
    source: "template",
  };
}

export async function draftAnnouncement(id) {
  const app = appById(id);
  const [version, announcements] = await Promise.all([readVersion(app), listAnnouncements(app)]);
  const last = announcements[0];
  const commits = await commitsSince(app, last?.publishedAt);
  if (!commits.length) throw Object.assign(new Error("Belum ada perubahan sejak Info developer terakhir"), { status: 409 });
  const examples = announcements
    .slice(0, 3)
    .map((a) => `JUDUL: ${a.title}\nISI:\n${a.body}`)
    .join("\n---\n");
  const log = commits.map((c) => `- ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, "\n  ")}` : ""}`).join("\n");
  const prompt = `Kamu menulis kartu "Info developer" yang tampil di tab Hub aplikasi ${app.name} (aplikasi pendamping Valorant, pengguna Indonesia).
Tulis dari daftar commit di bawah. Aturan:
- Bahasa Indonesia santai dan ramah, sapa pengguna dengan "kamu". Fokus ke manfaat yang terasa pengguna, bukan detail teknis.
- Abaikan perubahan internal (build, versi, refactor, tooling, dokumen) kecuali berdampak ke pengguna.
- Judul maksimal 50 karakter. Isi 2-4 kalimat atau poin singkat, maksimal 400 karakter. Boleh pakai baris baru.
- type: "update" bila ada fitur atau tampilan baru, "bugfix" bila hanya perbaikan, "info" untuk lainnya.
- Jangan menyebut nama model AI, commit, atau nomor versi di isi.
Balas HANYA JSON: {"type": "...", "title": "...", "body": "..."}

Versi aplikasi saat ini: ${version.versionName}
${examples ? `Contoh kartu sebelumnya (ikuti gayanya):\n${examples}\n` : ""}
Commit sejak kartu terakhir:
${log}`;
  try {
    const out = await claudeJson(prompt, app.repo);
    if (!out.title || !out.body) throw new Error("Draf kosong");
    return { type: TYPES.has(out.type) ? out.type : "update", title: String(out.title), body: String(out.body), version: version.versionName, source: "claude" };
  } catch (e) {
    return { ...fallbackDraft(app, version, commits), version: version.versionName, warning: `Draf Claude gagal (${e.message}); memakai template dari judul commit.` };
  }
}

// ---------- Posting / hapus ----------

export async function postAnnouncement(id, input) {
  const app = appById(id);
  const title = String(input.title || "").trim();
  const body = String(input.body || "").trim();
  const type = TYPES.has(input.type) ? input.type : "info";
  const version = String(input.version || "").trim();
  if (!title || !body) throw Object.assign(new Error("Judul dan isi wajib diisi"), { status: 400 });
  if (title.length > 120 || body.length > 2000) throw Object.assign(new Error("Judul atau isi terlalu panjang"), { status: 400 });
  const fields = {
    title: { stringValue: title },
    body: { stringValue: body },
    type: { stringValue: type },
    publishedAt: { timestampValue: new Date().toISOString() },
  };
  if (version) fields.version = { stringValue: version };
  return parseDoc(await firestore(app, "POST", "", { fields }));
}

export async function deleteAnnouncement(id, docId) {
  const app = appById(id);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(docId))) throw Object.assign(new Error("ID tidak valid"), { status: 400 });
  await firestore(app, "DELETE", `/${docId}`);
  return { deleted: docId };
}
