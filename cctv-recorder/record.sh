#!/bin/bash
# Rekam CCTV (ONVIF/RTSP) per jam ke /mnt/cctv/YYYY-MM-DD/HH-MM-SS.mp4 (biasanya HH-00-00)
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

log() { echo "[rec] $(date +%FT%T%z) $*" >> "$LOG"; }

# Jangan pernah menulis ke $REC_DIR kalau itu bukan disk eksternal yang
# benar-benar ter-mount (mis. disk CCTV lepas) -- supaya rekaman tidak diam-diam
# nyasar ke disk sistem. Tunggu sebentar siapa tahu cctv-mount-watchdog baru
# saja memperbaikinya; kalau tetap tidak ter-mount, keluar supaya systemd
# mencoba lagi (Restart=always) sampai mount kembali sehat.
tries=0
while ! mountpoint -q "$REC_DIR"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 15 ]; then
    log "$REC_DIR belum ter-mount setelah ditunggu, keluar (akan dicoba lagi)"
    exit 1
  fi
  sleep 2
done

log "mulai rekam -> $REC_DIR"

# -strftime 1 pakai waktu lokal server (ikut timezone sistem, mis. WIB), jadi
# folder/nama berkas HARUS dibuat dengan waktu lokal juga (bukan -u/UTC) di bawah ini,
# supaya tidak meleset dari folder yang sedang ditulis ffmpeg.
#
# movflags frag_keyframe+empty_moov membuat setiap berkas MP4 punya header (moov) di
# awal dan ditulis per-fragmen, jadi rekaman jam yang SEDANG berjalan tetap bisa
# diputar/diunduh (tidak perlu menunggu jam itu selesai), dan tahan terhadap
# crash/restart di tengah jalan (fragmen yang sudah ditulis tetap valid).
#
# Nama berkas memakai menit+detik (%H-%M-%S), bukan "%H-00-00": kalau perekam
# di-restart di tengah jam, ffmpeg membuat berkas baru (mis. 06-38-10.mp4)
# alih-alih MENIMPA berkas jam itu dan menghapus rekaman sebelumnya.
ffmpeg -nostdin -loglevel warning \
  -rtsp_transport tcp -timeout 10000000 \
  -i "$RTSP_URL" \
  -c:v copy -c:a aac -b:a 64k \
  -f segment -segment_time 3600 -segment_atclocktime 1 -reset_timestamps 1 \
  -segment_format mp4 -segment_format_options "movflags=+frag_keyframe+empty_moov+default_base_moof" \
  -strftime 1 "$REC_DIR/%Y-%m-%d/%H-%M-%S.mp4" \
  >> "$LOG" 2>&1 &
pid=$!

mkdir -p "$REC_DIR/$(date +%Y-%m-%d)"

# ffmpeg -strftime tidak otomatis membuat folder tanggal baru; pantau dan buat saat jam berganti.
while kill -0 "$pid" 2>/dev/null; do
  mkdir -p "$REC_DIR/$(date +%Y-%m-%d)"
  sleep 20
done
wait "$pid"
code=$?
log "ffmpeg berhenti (exit $code)"
exit "$code"
