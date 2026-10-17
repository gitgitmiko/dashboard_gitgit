#!/bin/bash
# Rekam CCTV (ONVIF/RTSP) per jam ke /mnt/cctv/YYYY-MM-DD/HH-00-00.mp4
# ffmpeg -c copy (tanpa re-encode) dengan -f segment supaya file dipotong tepat tiap jam.
# Dipanggil ulang otomatis oleh systemd (Restart=always) kalau kamera/stream putus.
set -uo pipefail

export PATH="/home/gitgitmiko/.hermes/tools/ffmpeg-9.0.1-linux-x64/bin:$PATH"
ENV_FILE="$(dirname "$0")/cctv.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

RTSP_URL="${CCTV_RTSP_URL:?CCTV_RTSP_URL belum diset di cctv.env}"
REC_DIR="${CCTV_REC_DIR:-/mnt/cctv}"
LOG="${CCTV_LOG:-/home/gitgitmiko/cron/cctv/recorder.log}"
mkdir -p "$(dirname "$LOG")"

log() { echo "[rec] $(date -u +%FT%TZ) $*" >> "$LOG"; }

log "mulai rekam -> $REC_DIR"

ffmpeg -nostdin -loglevel warning \
  -rtsp_transport tcp -timeout 10000000 \
  -i "$RTSP_URL" \
  -c:v copy -c:a aac -b:a 64k \
  -f segment -segment_time 3600 -segment_atclocktime 1 -reset_timestamps 1 \
  -segment_format mp4 -segment_format_options movflags=+faststart \
  -strftime 1 "$REC_DIR/%Y-%m-%d/%H-00-00.mp4" \
  >> "$LOG" 2>&1 &
pid=$!

mkdir -p "$REC_DIR/$(date -u +%Y-%m-%d)"

# ffmpeg -strftime tidak otomatis membuat folder tanggal baru; pantau dan buat saat jam berganti.
while kill -0 "$pid" 2>/dev/null; do
  mkdir -p "$REC_DIR/$(date -u +%Y-%m-%d)"
  sleep 20
done
wait "$pid"
code=$?
log "ffmpeg berhenti (exit $code)"
exit "$code"
