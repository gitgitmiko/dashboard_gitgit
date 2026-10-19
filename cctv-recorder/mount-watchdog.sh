#!/bin/bash
# Dipanggil tiap 1 menit oleh cctv-mount-watchdog.timer.
#
# Kalau harddisk CCTV terputus lalu konek lagi, device-nya sering berganti
# nama (mis. /dev/sda -> /dev/sdb), sementara mount /mnt/cctv yang lama
# masih "menunjuk" ke device mati -> setiap akses gagal EIO. Script ini
# mendeteksi kondisi itu, mount ulang otomatis ke device yang benar (dicari
# lewat UUID, bukan nama device), lalu menyalakan ulang perekam.
#
# fstab untuk /mnt/cctv memakai opsi "users" supaya mount/umount di bawah
# ini tidak perlu sudo.
set -uo pipefail

REC_DIR="${CCTV_REC_DIR:-/mnt/cctv}"
UUID="${CCTV_DISK_UUID:-b4c489d1-2880-4682-87a8-fe8191b58d22}"
LOG="${CCTV_LOG:-/home/gitgitmiko/cron/cctv/recorder.log}"
STATE="/home/gitgitmiko/cron/cctv/mount-watchdog.state"
mkdir -p "$(dirname "$LOG")"

log() { echo "[mount-watchdog] $(date +%FT%T%z) $*" >> "$LOG"; }

# Hanya catat log saat status BERUBAH, supaya log tidak penuh tiap menit.
note_once() {
  local key="$1"; shift
  if [ "$(cat "$STATE" 2>/dev/null)" != "$key" ]; then
    echo "$key" > "$STATE"
    log "$*"
  fi
}

device="$(blkid -U "$UUID" 2>/dev/null || true)"

if [ -z "$device" ]; then
  note_once "absent" "disk CCTV (UUID $UUID) tidak terdeteksi di sistem"
  exit 0
fi

mounted_source="$(findmnt -no SOURCE --target "$REC_DIR" 2>/dev/null || true)"
healthy=0
if [ -n "$mounted_source" ] && [ "$mounted_source" = "$device" ]; then
  if timeout 5 stat "$REC_DIR" >/dev/null 2>&1; then
    healthy=1
  fi
fi

if [ "$healthy" = "1" ]; then
  note_once "ok:$device" "sehat, terpasang di $device"
  exit 0
fi

log "perlu mount ulang (device=$device, mounted_source=${mounted_source:-tidak ada}, sehat=$healthy) -> memperbaiki"
umount -l "$REC_DIR" 2>>"$LOG"
if mount "$REC_DIR" 2>>"$LOG"; then
  log "mount ulang berhasil -> $(findmnt -no SOURCE --target "$REC_DIR" 2>/dev/null)"
  echo "fixed:$device" > "$STATE"
  systemctl --user restart cctv-recorder.service
  log "cctv-recorder.service disambungkan ulang"
else
  note_once "mount-gagal" "mount ulang GAGAL, cek disk/koneksi USB"
fi
