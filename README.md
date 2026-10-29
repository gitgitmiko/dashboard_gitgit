# Dashboard Gitgit

Dasbor pemakaian server, penjelajah folder, dan terminal web. Dipasang di `https://gitgitmiko.my.id/agen/`.

Kata sandi dibaca dari environment `DASHBOARD_PASSWORD` atau file `.env` di folder ini (tidak disimpan di repo).

```bash
npm install
# Isi DASHBOARD_PASSWORD di .env, atau ekspor sebelum menjalankan:
# DASHBOARD_PASSWORD=... HOST=127.0.0.1 PORT=4180 BASE_PATH=/agen node server.js
HOST=127.0.0.1 PORT=4180 BASE_PATH=/agen node server.js
```

Setelah masuk:

- **Ringkasan** — CPU, memori, penyimpanan, dan jaringan
- **Folder** — daftar isi disk server, pratinjau, dan unduh
- **Terminal** — shell login di browser. Sesi dan riwayat tetap hidup saat refresh atau browser ditutup; hanya tombol **Tutup** yang mematikan shell.
- **Sosmed** — status posting otomatis Instagram/Facebook dari `scraper-data-gitgit` (jadwal hari ini, riwayat, link postingan, error). Data dibaca dari API `scraper-social-api`; isi `SOCIAL_API_KEY` (dan opsional `SOCIAL_API_URL`, default `http://172.18.0.1:8791`) di `.env`.
- **YouTube** — monitoring channel KUISABON dari `youtube_short_automation` (jadwal hari ini, video yang sedang dibuat, riwayat + link Shorts, error, log service). Data dibaca dari API service `kuisabon`; isi `KUISABON_API_TOKEN` (= `SERVICE_TOKEN` di `.env` youtube_short_automation, opsional `KUISABON_API_URL`, default `http://172.18.0.1:8797`) di `.env`.
