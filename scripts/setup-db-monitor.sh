#!/usr/bin/env bash
# Buat user monitoring READ-ONLY untuk menu Database dashboard, lalu simpan kredensialnya di .env.
#   MySQL    : dg_monitor@localhost/127.0.0.1 — SELECT, PROCESS, SHOW DATABASES, SHOW VIEW (tanpa hak ubah).
#   Postgres : role dg_monitor di container n8n — pg_monitor + pg_read_all_data, transaksi dipaksa read-only.
# Aman dijalankan ulang (password diganti baru). MySQL butuh sudo.
#   bash scripts/setup-db-monitor.sh            # keduanya
#   bash scripts/setup-db-monitor.sh mysql      # hanya MySQL
#   bash scripts/setup-db-monitor.sh postgres   # hanya Postgres
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=.env
PG_CONTAINER="${DB_MON_PG_CONTAINER:-n8n-instagram-postgres-1}"
WHICH="${1:-all}"

# Ganti/isi satu baris KEY=VALUE di .env tanpa menyentuh baris lain.
set_env() {
  local key=$1 value=$2
  touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE"; then
    local tmp
    tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE" && rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

if [[ $WHICH == all || $WHICH == mysql ]]; then
  echo "== MySQL (perlu password sudo)"
  PW=$(openssl rand -hex 20)
  sudo mysql <<SQL
CREATE USER IF NOT EXISTS 'dg_monitor'@'localhost' IDENTIFIED BY '$PW';
CREATE USER IF NOT EXISTS 'dg_monitor'@'127.0.0.1' IDENTIFIED BY '$PW';
ALTER USER 'dg_monitor'@'localhost' IDENTIFIED BY '$PW' WITH MAX_USER_CONNECTIONS 5;
ALTER USER 'dg_monitor'@'127.0.0.1' IDENTIFIED BY '$PW' WITH MAX_USER_CONNECTIONS 5;
GRANT SELECT, PROCESS, SHOW DATABASES, SHOW VIEW ON *.* TO 'dg_monitor'@'localhost';
GRANT SELECT, PROCESS, SHOW DATABASES, SHOW VIEW ON *.* TO 'dg_monitor'@'127.0.0.1';
SQL
  set_env DB_MON_MYSQL_USER dg_monitor
  set_env DB_MON_MYSQL_PASSWORD "$PW"
  echo "   OK: user dg_monitor dibuat"
fi

if [[ $WHICH == all || $WHICH == postgres ]]; then
  echo "== PostgreSQL ($PG_CONTAINER)"
  PW=$(openssl rand -hex 20)
  SUPER=$(docker exec "$PG_CONTAINER" sh -c 'echo "$POSTGRES_USER"')
  docker exec -i "$PG_CONTAINER" psql -U "$SUPER" -d postgres -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dg_monitor') THEN
    CREATE ROLE dg_monitor LOGIN PASSWORD '$PW';
  ELSE
    ALTER ROLE dg_monitor LOGIN PASSWORD '$PW';
  END IF;
END \$\$;
GRANT pg_monitor, pg_read_all_data TO dg_monitor;
ALTER ROLE dg_monitor SET default_transaction_read_only = on;
ALTER ROLE dg_monitor SET statement_timeout = '8s';
ALTER ROLE dg_monitor CONNECTION LIMIT 5;
SQL
  set_env DB_MON_PG_CONTAINER "$PG_CONTAINER"
  set_env DB_MON_PG_USER dg_monitor
  set_env DB_MON_PG_PASSWORD "$PW"
  echo "   OK: role dg_monitor dibuat"
fi

echo "== Restart dashboard"
systemctl --user restart dashboard-gitgit
echo "Selesai. Buka menu Database di dashboard."
