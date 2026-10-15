# Dashboard Gitgit

Dasbor pemakaian server, penjelajah folder, dan terminal web. Dipasang di `https://gitgitmiko.my.id/agen/`.

Kata sandi dibaca dari environment `DASHBOARD_PASSWORD`, tidak disimpan di repo ini.

```bash
npm install
DASHBOARD_PASSWORD=... HOST=127.0.0.1 PORT=4180 BASE_PATH=/agen node server.js
```

Setelah masuk:

- **Ringkasan** — CPU, memori, penyimpanan, dan jaringan
- **Folder** — daftar isi disk server, pratinjau, dan unduh
- **Terminal** — shell login di browser (WebSocket)
