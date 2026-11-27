// Monitoring database untuk menu Database: MySQL (host), PostgreSQL (container n8n) dan
// berkas SQLite. Semua akses read-only: user monitoring khusus (lihat
// scripts/setup-db-monitor.sh) + sesi/transaksi read-only + batas waktu query.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";
import pg from "pg";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const env = process.env;
const ROW_PAGE_SIZES = [10, 25, 50, 100];
const CELL_MAX = 2000;
// Di bawah batas ini jumlah baris dihitung persis (COUNT(*)); di atasnya pakai perkiraan statistik.
const EXACT_COUNT_MAX = 200_000;
const MYSQL_SYSTEM = new Set(["mysql", "sys", "performance_schema", "information_schema"]);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- konfigurasi sumber ----------

const DEFAULT_SQLITE = [
  ["9router", join(HOME, ".9router", "db", "data.sqlite")],
  ["Home Assistant", join(HOME, "cctv-stack", "homeassistant", "home-assistant_v2.db")],
  ["Frigate", join(HOME, "cctv-stack", "frigate", "config", "frigate.db")],
  ["Hermes", join(HOME, ".hermes", "state.db")],
  ["gflow", join(HOME, ".local", "share", "gflow-cli", "gflow.db")],
  ["Apa yang terjadi jika", join(HOME, "github-repos", "whatif-automation", "data", "whatif.db")],
];

function sqliteSources() {
  // DB_MON_SQLITE="Label=/path/a.db;Label 2=/path/b.sqlite" menggantikan daftar bawaan.
  const list = env.DB_MON_SQLITE
    ? env.DB_MON_SQLITE.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf("=");
        return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : [basename(p), p];
      })
    : DEFAULT_SQLITE;
  return list
    .filter(([, file]) => existsSync(file))
    .map(([label, file]) => ({ id: `sqlite-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, kind: "sqlite", label, file }));
}

function sources() {
  return [
    { id: "mysql", kind: "mysql", label: "MySQL", configured: !!(env.DB_MON_MYSQL_USER && env.DB_MON_MYSQL_PASSWORD) },
    { id: "postgres", kind: "postgres", label: "PostgreSQL (n8n)", configured: !!(env.DB_MON_PG_USER && env.DB_MON_PG_PASSWORD) },
    ...sqliteSources().map((s) => ({ ...s, configured: true })),
  ];
}

function findSource(id) {
  const src = sources().find((s) => s.id === id);
  if (!src) throw httpError(404, "Database tidak dikenal");
  if (!src.configured) throw httpError(409, "Belum dikonfigurasi: jalankan scripts/setup-db-monitor.sh");
  return src;
}

// ---------- serialisasi nilai sel ----------

function cell(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { binary: v.length };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") v = JSON.stringify(v);
  if (typeof v === "string" && v.length > CELL_MAX) return { text: v.slice(0, CELL_MAX), truncated: v.length };
  return v;
}

function pageArgs(rawPage, rawSize) {
  const pageSize = ROW_PAGE_SIZES.includes(Number(rawSize)) ? Number(rawSize) : 10;
  const page = Math.max(1, Math.floor(Number(rawPage)) || 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// ---------- MySQL ----------

let mysqlPool = null;
const mysqlPrev = { at: 0, questions: 0 };

function mysqlConn() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: env.DB_MON_MYSQL_HOST || "127.0.0.1",
      port: Number(env.DB_MON_MYSQL_PORT || 3306),
      user: env.DB_MON_MYSQL_USER,
      password: env.DB_MON_MYSQL_PASSWORD,
      connectionLimit: 3,
      connectTimeout: 5000,
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    mysqlPool.on("connection", (c) => {
      // Statistik information_schema MySQL 8 di-cache 24 jam secara bawaan → paksa segar.
      c.query("SET SESSION information_schema_stats_expiry = 0, SESSION max_execution_time = 8000, SESSION transaction_read_only = ON");
    });
  }
  return mysqlPool;
}

async function mq(sql, params = []) {
  const [rows] = await mysqlConn().query(sql, params);
  return rows;
}

const qid = (s) => `\`${String(s).replace(/`/g, "``")}\``;

async function mysqlOverview() {
  const [ver] = await mq("SELECT VERSION() AS v");
  const status = Object.fromEntries((await mq("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries')")).map((r) => [r.Variable_name, Number(r.Value)]));
  const [maxConn] = await mq("SHOW VARIABLES LIKE 'max_connections'");
  const dbs = await mysqlDatabases();
  const now = Date.now();
  let qps = null;
  if (mysqlPrev.at && now > mysqlPrev.at) qps = Math.max(0, (status.Questions - mysqlPrev.questions) / ((now - mysqlPrev.at) / 1000));
  Object.assign(mysqlPrev, { at: now, questions: status.Questions });
  return {
    version: `MySQL ${ver.v}`,
    uptime: status.Uptime,
    size: dbs.reduce((n, d) => n + d.size, 0),
    databases: dbs.length,
    connections: status.Threads_connected,
    maxConnections: Number(maxConn?.Value) || null,
    active: Math.max(0, status.Threads_running - 1), // tanpa koneksi monitoring ini sendiri
    qps,
    slowQueries: status.Slow_queries,
  };
}

async function mysqlDatabases() {
  const rows = await mq(`SELECT s.SCHEMA_NAME AS name, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size, COUNT(t.TABLE_NAME) AS tables
    FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
    GROUP BY s.SCHEMA_NAME ORDER BY size DESC`);
  return rows.filter((r) => !MYSQL_SYSTEM.has(r.name)).map((r) => ({ name: r.name, size: Number(r.size), tables: Number(r.tables) }));
}

async function mysqlTables(db) {
  const rows = await mq(`SELECT TABLE_NAME AS name, TABLE_ROWS AS est, DATA_LENGTH AS data, INDEX_LENGTH AS idx, ENGINE AS engine, UPDATE_TIME AS updated
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY DATA_LENGTH + INDEX_LENGTH DESC`, [db]);
  return rows.map((r) => ({
    name: r.name,
    rows: Number(r.est) || 0,
    rowsApprox: true,
    size: Number(r.data) + Number(r.idx),
    indexSize: Number(r.idx),
    engine: r.engine,
    updated: r.updated ? new Date(r.updated).toISOString() : null,
  }));
}

async function mysqlQueries() {
  const rows = await mq(`SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time, STATE AS state, LEFT(INFO, ${CELL_MAX}) AS query
    FROM information_schema.PROCESSLIST WHERE COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump') AND ID <> CONNECTION_ID() ORDER BY TIME DESC`);
  const idle = await mq("SELECT USER AS user, COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE COMMAND = 'Sleep' GROUP BY USER ORDER BY n DESC");
  return {
    active: rows.map((r) => ({ id: String(r.id), user: r.user, client: r.host, db: r.db, state: r.state || r.command, seconds: Number(r.time), query: r.query })),
    idle: idle.map((r) => ({ user: r.user, count: Number(r.n) })),
  };
}

async function mysqlRows(db, table, args) {
  const tables = await mysqlTables(db);
  const t = tables.find((x) => x.name === table);
  if (!t) throw httpError(404, "Tabel tidak ditemukan");
  const cols = await mq(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS ckey FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
  const columns = cols.map((c) => ({ name: c.name, type: c.type, pk: c.ckey === "PRI" }));
  const order = sortSpec(columns, args.sort, args.dir);
  let total = t.rows;
  let approx = true;
  if (t.rows < EXACT_COUNT_MAX) {
    const [c] = await mq(`SELECT COUNT(*) AS n FROM ${qid(db)}.${qid(table)}`);
    total = Number(c.n);
    approx = false;
  }
  const rows = await mq(
    `SELECT * FROM ${qid(db)}.${qid(table)}${order ? ` ORDER BY ${qid(order.col)} ${order.dir}` : ""} LIMIT ? OFFSET ?`,
    [args.pageSize, args.offset],
  );
  return { columns, rows: rows.map((r) => columns.map((c) => cell(r[c.name]))), total, approx, sort: order };
}

// ---------- PostgreSQL ----------

const pgPools = new Map();
let pgHost = null;
const pgPrev = { at: 0, xacts: 0 };

async function resolvePgHost() {
  if (env.DB_MON_PG_HOST) return env.DB_MON_PG_HOST;
  if (pgHost) return pgHost;
  // Postgres n8n tidak membuka port ke host; IP container bisa berubah setelah restart.
  const name = env.DB_MON_PG_CONTAINER || "n8n-instagram-postgres-1";
  const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", name], { timeout: 5000 });
  const ip = stdout.trim().split(/\s+/)[0];
  if (!ip) throw new Error(`IP container ${name} tidak ditemukan (container mati?)`);
  pgHost = ip;
  return ip;
}

async function pgPool(database) {
  const db = database || env.DB_MON_PG_DATABASE || "postgres";
  let pool = pgPools.get(db);
  if (!pool) {
    pool = new pg.Pool({
      host: await resolvePgHost(),
      port: Number(env.DB_MON_PG_PORT || 5432),
      user: env.DB_MON_PG_USER,
      password: env.DB_MON_PG_PASSWORD,
      database: db,
      max: 2,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 8000,
      options: "-c default_transaction_read_only=on",
    });
    pool.on("error", () => {});
    pgPools.set(db, pool);
  }
  return pool;
}

async function pq(database, sql, params = []) {
  try {
    const pool = await pgPool(database);
    return (await pool.query(sql, params)).rows;
  } catch (err) {
    // Koneksi gagal (mis. IP container berubah): buang pool & cache IP, coba lagi lain kali.
    if (/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timeout expired/i.test(err.message)) {
      for (const p of pgPools.values()) p.end().catch(() => {});
      pgPools.clear();
      pgHost = null;
    }
    throw err;
  }
}

const pid = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function pgOverview() {
  const [info] = await pq(null, `SELECT version() AS version, EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint AS uptime,
    current_setting('max_connections')::int AS max_conn,
    (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS conns,
    (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND state <> 'idle' AND pid <> pg_backend_pid()) AS active,
    (SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database) AS xacts`);
  const dbs = await pgDatabases();
  const now = Date.now();
  const xacts = Number(info.xacts);
  let tps = null;
  if (pgPrev.at && now > pgPrev.at) tps = Math.max(0, (xacts - pgPrev.xacts) / ((now - pgPrev.at) / 1000));
  Object.assign(pgPrev, { at: now, xacts });
  return {
    version: String(info.version).split(" on ")[0],
    uptime: Number(info.uptime),
    size: dbs.reduce((n, d) => n + d.size, 0),
    databases: dbs.length,
    connections: Number(info.conns),
    maxConnections: info.max_conn,
    active: Number(info.active),
    qps: tps,
  };
}

async function pgDatabases() {
  const rows = await pq(null, "SELECT datname AS name, pg_database_size(datname) AS size FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 2 DESC");
  return rows.map((r) => ({ name: r.name, size: Number(r.size), tables: null }));
}

async function pgTables(db) {
  await assertPgDb(db);
  const rows = await pq(db, `SELECT n.nspname AS schema, c.relname AS name, GREATEST(COALESCE(s.n_live_tup, 0), c.reltuples::bigint, 0) AS est,
      pg_total_relation_size(c.oid) AS size, pg_indexes_size(c.oid) AS idx,
      GREATEST(s.last_autovacuum, s.last_vacuum, s.last_autoanalyze, s.last_analyze) AS maintained
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY 4 DESC`);
  return rows.map((r) => ({
    name: r.schema === "public" ? r.name : `${r.schema}.${r.name}`,
    schema: r.schema,
    table: r.name,
    rows: Number(r.est),
    rowsApprox: true,
    size: Number(r.size),
    indexSize: Number(r.idx),
    engine: null,
    updated: r.maintained ? new Date(r.maintained).toISOString() : null,
  }));
}

async function assertPgDb(db) {
  if (!(await pgDatabases()).some((d) => d.name === db)) throw httpError(404, "Database tidak ditemukan");
}

async function pgQueries() {
  const rows = await pq(null, `SELECT pid, usename AS user, datname AS db, COALESCE(host(client_addr), 'lokal') AS client, state, wait_event,
      EXTRACT(EPOCH FROM now() - COALESCE(query_start, backend_start))::int AS seconds, LEFT(query, ${CELL_MAX}) AS query
    FROM pg_stat_activity WHERE backend_type = 'client backend' AND state <> 'idle' AND pid <> pg_backend_pid() ORDER BY seconds DESC`);
  const idle = await pq(null, "SELECT usename AS user, count(*) AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'idle' GROUP BY usename ORDER BY 2 DESC");
  return {
    active: rows.map((r) => ({ id: String(r.pid), user: r.user, client: r.client, db: r.db, state: r.wait_event ? `${r.state} (${r.wait_event})` : r.state, seconds: Number(r.seconds), query: r.query })),
    idle: idle.map((r) => ({ user: r.user, count: Number(r.n) })),
  };
}

async function pgRows(db, table, args) {
  const t = (await pgTables(db)).find((x) => x.name === table);
  if (!t) throw httpError(404, "Tabel tidak ditemukan");
  const cols = await pq(db, `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
    FROM pg_attribute a WHERE a.attrelid = ($1 || '.' || $2)::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
  [pid(t.schema), pid(t.table)]);
  const columns = cols.map((c) => ({ name: c.name, type: c.type, pk: c.pk }));
  const order = sortSpec(columns, args.sort, args.dir);
  const from = `${pid(t.schema)}.${pid(t.table)}`;
  let total = t.rows;
  let approx = true;
  if (t.rows < EXACT_COUNT_MAX) {
    const [c] = await pq(db, `SELECT count(*) AS n FROM ${from}`);
    total = Number(c.n);
    approx = false;
  }
  const rows = await pq(db, `SELECT * FROM ${from}${order ? ` ORDER BY ${pid(order.col)} ${order.dir}` : ""} LIMIT $1 OFFSET $2`, [args.pageSize, args.offset]);
  return { columns, rows: rows.map((r) => columns.map((c) => cell(r[c.name]))), total, approx, sort: order };
}

// ---------- SQLite ----------

function withSqlite(src, fn) {
  const db = new DatabaseSync(src.file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = 1");
    return fn(db);
  } finally {
    db.close();
  }
}

function fileSize(file) {
  let n = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      n += statSync(f).size;
    } catch {
      /* tidak ada WAL */
    }
  }
  return n;
}

function sqliteOverview(src) {
  return withSqlite(src, (db) => {
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n;
    const journal = db.prepare("PRAGMA journal_mode").get().journal_mode;
    const ver = db.prepare("SELECT sqlite_version() AS v").get().v;
    const st = statSync(src.file);
    return {
      version: `SQLite ${ver} · ${journal}`,
      uptime: null,
      size: fileSize(src.file),
      databases: 1,
      tables: Number(tables),
      connections: null,
      maxConnections: null,
      active: null,
      qps: null,
      file: src.file,
      modified: st.mtime.toISOString(),
    };
  });
}

function sqliteTableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}

function sqliteTables(src) {
  return withSqlite(src, (db) => {
    const sizes = new Map();
    try {
      // dbstat: ukuran per objek; indeks dijumlahkan ke tabelnya lewat sqlite_master.tbl_name.
      const owner = new Map(db.prepare("SELECT name, tbl_name FROM sqlite_master").all().map((r) => [r.name, r.tbl_name]));
      for (const r of db.prepare("SELECT name, sum(pgsize) AS size FROM dbstat GROUP BY name").all()) {
        const t = owner.get(r.name) || r.name;
        const cur = sizes.get(t) || { size: 0, idx: 0 };
        cur.size += Number(r.size);
        if (t !== r.name) cur.idx += Number(r.size);
        sizes.set(t, cur);
      }
    } catch {
      /* dbstat tidak tersedia */
    }
    return sqliteTableNames(db)
      .map((name) => ({
        name,
        rows: Number(db.prepare(`SELECT count(*) AS n FROM ${pid(name)}`).get().n),
        rowsApprox: false,
        size: sizes.get(name)?.size ?? null,
        indexSize: sizes.get(name)?.idx ?? null,
        engine: null,
        updated: null,
      }))
      .sort((a, b) => (b.size ?? b.rows) - (a.size ?? a.rows));
  });
}

function sqliteRows(src, table, args) {
  return withSqlite(src, (db) => {
    if (!sqliteTableNames(db).includes(table)) throw httpError(404, "Tabel tidak ditemukan");
    const columns = db.prepare(`PRAGMA table_info(${pid(table)})`).all().map((c) => ({ name: c.name, type: c.type || "", pk: c.pk > 0 }));
    const withoutRowid = /WITHOUT\s+ROWID/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table)?.sql || "");
    let order = sortSpec(columns, args.sort, args.dir);
    let orderSql = order ? ` ORDER BY ${pid(order.col)} ${order.dir}` : "";
    if (!order && !withoutRowid) orderSql = " ORDER BY rowid DESC"; // terbaru dulu
    const total = Number(db.prepare(`SELECT count(*) AS n FROM ${pid(table)}`).get().n);
    const rows = db.prepare(`SELECT * FROM ${pid(table)}${orderSql} LIMIT ? OFFSET ?`).all(args.pageSize, args.offset);
    return { columns, rows: rows.map((r) => columns.map((c) => cell(r[c.name]))), total, approx: false, sort: order };
  });
}

// Urutan: kolom yang diminta (harus ada di tabel), atau primary key menurun (data terbaru dulu).
function sortSpec(columns, sort, dir) {
  const d = String(dir).toLowerCase() === "asc" ? "ASC" : "DESC";
  if (sort && columns.some((c) => c.name === sort)) return { col: sort, dir: d };
  const pk = columns.filter((c) => c.pk);
  return pk.length === 1 ? { col: pk[0].name, dir: "DESC" } : null;
}

// ---------- API ----------

async function overviewOf(src) {
  if (!src.configured) return { status: "unconfigured" };
  try {
    const data = src.kind === "mysql" ? await mysqlOverview() : src.kind === "postgres" ? await pgOverview() : sqliteOverview(src);
    return { status: "ok", ...data };
  } catch (err) {
    return { status: "error", message: err.message };
  }
}

export async function dbOverview() {
  const list = sources();
  const results = await Promise.all(list.map(overviewOf));
  return {
    sources: list.map((s, i) => ({ id: s.id, kind: s.kind, label: s.label, ...results[i] })),
  };
}

export async function dbDatabases(id) {
  const src = findSource(id);
  if (src.kind === "mysql") return { databases: await mysqlDatabases() };
  if (src.kind === "postgres") return { databases: await pgDatabases() };
  return { databases: [{ name: "main", size: fileSize(src.file), tables: null }] };
}

export async function dbTables(id, db) {
  const src = findSource(id);
  if (src.kind === "mysql") {
    if (!(await mysqlDatabases()).some((d) => d.name === db)) throw httpError(404, "Database tidak ditemukan");
    return { tables: await mysqlTables(db) };
  }
  if (src.kind === "postgres") return { tables: await pgTables(db) };
  return { tables: sqliteTables(src) };
}

export async function dbQueries(id) {
  const src = findSource(id);
  if (src.kind === "mysql") return await mysqlQueries();
  if (src.kind === "postgres") return await pgQueries();
  throw httpError(400, "SQLite tidak punya server, jadi tidak ada query aktif");
}

export async function dbRows(id, db, table, params) {
  const src = findSource(id);
  const args = { ...pageArgs(params.page, params.pageSize), sort: params.sort, dir: params.dir };
  let data;
  if (src.kind === "mysql") {
    if (!(await mysqlDatabases()).some((d) => d.name === db)) throw httpError(404, "Database tidak ditemukan");
    data = await mysqlRows(db, table, args);
  } else if (src.kind === "postgres") data = await pgRows(db, table, args);
  else data = sqliteRows(src, table, args);
  return { ...data, page: args.page, pageSize: args.pageSize, totalPages: Math.max(1, Math.ceil(data.total / args.pageSize)) };
}
