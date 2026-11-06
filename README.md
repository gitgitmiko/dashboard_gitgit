# Dashboard Gitgit

Dasbor pemakaian server, penjelajah folder, dan terminal web. Dipasang di `https://gitgitmiko.my.id/agen/`.

Kata sandi dibaca dari environment `DASHBOARD_PASSWORD` atau file `.env` di folder ini (tidak disimpan di repo).

```bash
npm install
# Isi DASHBOARD_PASSWORD di .env, atau ekspor sebelum menjalankan:
# DASHBOARD_PASSWORD=... HOST=127.0.0.1 PORT=4180 BASE_PATH=/agen node server.js
HOST=127.0.0.1 PORT=4180 BASE_PATH=/agen node server.js
```

### UI baru (React) — masa transisi

UI baru dibangun dengan Vite + React + TypeScript + Tailwind + shadcn/ui di folder `web/` dan disajikan di **`https://dashboard.gitgitmiko.my.id/`** (juga di `https://gitgitmiko.my.id/agen/v2/`). Tab yang belum dipindah menautkan ke UI lama di `/agen/`.

Subdomain dilayani proses yang sama (port 4180, lewat Cloudflare Tunnel). Untuk host `DASHBOARD_HOST` (default `dashboard.gitgitmiko.my.id`), path di luar `/agen` dipetakan ke UI baru, sedangkan `/agen/...` (API, WebSocket terminal, UI lama) dilayani apa adanya. Cookie sesi di host itu memakai `Path=/`.

```bash
npm run build          # pasang dependency web/ lalu build ke web/dist (wajib setelah git pull)
cd web && npm run dev  # mode pengembangan di http://localhost:5173/agen/v2/, API diteruskan ke :4180
```

Catatan: terminal web berjalan di dalam service `dashboard-gitgit`, jadi `systemctl --user restart dashboard-gitgit` ikut menutup semua terminal yang terbuka. Perubahan yang hanya di `web/` cukup di-build, tanpa restart.

Setelah masuk:

- **Ringkasan** — CPU, memori, penyimpanan, jaringan, serta daftar alamat IP & domain: subdomain Cloudflare Tunnel (dibaca dari `~/.cloudflared/config.yml`), IP antarmuka server, port yang terbuka, IP container Docker, dan perangkat di LAN — masing-masing dengan keterangan fungsinya.
- **Folder** — daftar isi disk server, pratinjau, dan unduh
- **Terminal** — shell login di browser, satu tab per terminal (maks. 8). Sesi dan riwayat tetap hidup saat refresh, logout, atau browser ditutup; hanya tombol **×** (Tutup) yang mematikan shell. Di UI baru ada mode layar penuh dan bilah tombol Esc/Tab/Ctrl/panah untuk HP.
- **Log** — riwayat run scraper katalog (cron tiap 30 menit) dan log mentah `~/cron/scraper/scraper.log` dengan saringan dan muat ulang otomatis.
- **CCTV** — rekaman per jam di `/mnt/cctv/<tanggal>/`; pilih tanggal, putar langsung di browser (bisa di-seek, endpoint mendukung HTTP Range), atau unduh.
- **Sosmed** — status posting otomatis Instagram/Facebook dari `scraper-data-gitgit` (jadwal hari ini, riwayat, link postingan, error). Data dibaca dari API `scraper-social-api`; isi `SOCIAL_API_KEY` (dan opsional `SOCIAL_API_URL`, default `http://172.18.0.1:8791`) di `.env`.
- **YouTube** — monitoring channel KUISABON dari `youtube_short_automation` (jadwal hari ini, video yang sedang dibuat, riwayat + link Shorts, error, log service). Data dibaca dari API service `kuisabon`; isi `KUISABON_API_TOKEN` (= `SERVICE_TOKEN` di `.env` youtube_short_automation, opsional `KUISABON_API_URL`, default `http://172.18.0.1:8797`) di `.env`.
