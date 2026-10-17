#!/bin/bash
# Hapus rekaman CCTV lebih tua dari CCTV_RETENTION_DAYS (default 30 hari).
set -uo pipefail
ENV_FILE="$(dirname "$0")/cctv.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
REC_DIR="${CCTV_REC_DIR:-/mnt/cctv}"
DAYS="${CCTV_RETENTION_DAYS:-30}"
LOG="${CCTV_LOG:-/home/gitgitmiko/cron/cctv/recorder.log}"
log() { echo "[retention] $(date -u +%FT%TZ) $*" >> "$LOG"; }

mountpoint -q "$REC_DIR" || { log "lewati: $REC_DIR tidak ter-mount"; exit 0; }

deleted=$(find "$REC_DIR" -mindepth 1 -maxdepth 1 -type d -name "20??-??-??" -mtime "+$DAYS" -print)
if [ -n "$deleted" ]; then
  echo "$deleted" | while read -r d; do
    log "hapus folder lama: $d"
    rm -rf "$d"
  done
else
  log "tidak ada folder lebih tua dari $DAYS hari"
fi
