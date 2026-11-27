# Dashboard Gitgit

Dasbor pemakaian server, penjelajah folder, terminal web, dan pemantau otomasi. Dibuka di **`https://dashboard.gitgitmiko.my.id/`** (dilindungi Cloudflare Access + kata sandi dashboard).

Kata sandi dibaca dari environment `DASHBOARD_PASSWORD` atau file `.env` di folder ini (tidak disimpan di repo).

```bash
npm install
npm run build          # pasang dependency web/ lalu build UI ke web/dist (wajib setelah git pull)
HOST=127.0.0.1 PORT=4180 BASE_PATH=/agen node server.js
```

UI dibangun dengan Vite + React + TypeScript + Tailwind + shadcn/ui di folder `web/`. Untuk pengembangan: `cd web && npm run dev` (http://localhost:5173/agen/v2/, API diteruskan ke :4180). Perubahan yang hanya di `web/` cukup di-build ulang, tanpa restart service.

### Alamat dan akses

Satu proses (port 4180, hanya loopback) melayani semuanya lewat Cloudflare Tunnel:

| Alamat | Isi |
|---|---|
| `https://dashboard.gitgitmiko.my.id/` | UI baru. Path di luar `/agen` dipetakan ke `web/dist`; cookie sesi `Path=/`. |
| `https://dashboard.gitgitmiko.my.id/agen/...` | API, WebSocket terminal, dan unduhan (dipakai UI). `/agen` sendiri dialihkan ke `/`. |
| `https://gitgitmiko.my.id/agen/preview/whatif/...` | Link preview video What If, publik tanpa login. |
| `https://gitgitmiko.my.id/agen/...` lainnya | Dialihkan ke subdomain; login/API/terminal ditolak (403). |
| `http://127.0.0.1:4180/agen/v2/` | Akses lokal untuk perawatan (tanpa pembatasan host). `/agen` dialihkan ke sini. |

Host publik selain `DASHBOARD_HOST` (default `dashboard.gitgitmiko.my.id`) tidak dilindungi Cloudflare Access, jadi dikunci seperti di atas. Untuk membukanya lagi (mis. Access bermasalah), tambahkan `PUBLIC_HOST_LOCKDOWN=0` di `.env` lalu restart service.

Catatan: terminal web berjalan di dalam service `dashboard-gitgit`, jadi `systemctl --user restart dashboard-gitgit` ikut menutup semua terminal yang terbuka.

Setelah masuk:

- **Ringkasan** — CPU, memori, penyimpanan, jaringan, serta daftar alamat IP & domain: subdomain Cloudflare Tunnel (dibaca dari `~/.cloudflared/config.yml`), IP antarmuka server, port yang terbuka, IP container Docker, dan perangkat di LAN — masing-masing dengan keterangan fungsinya.
  Tombol **Bersihkan proses** (`cleanup.js`, `GET /api/cleanup`, `POST /api/cleanup/kill`) menghentikan proses *yatim* milik user dashboard yang sudah tidak diperlukan: Gradle/Kotlin daemon menganggur, browser headless dan `chrome_crashpad_handler` sisa otomasi, Xvfb tanpa pengguna. Proses milik service/timer/cron/Docker, terminal web beserta isinya, proses yang masih punya koneksi aktif atau masih memakai CPU, proses yang dirujuk service lain (mis. `Xvfb :99` ← `DISPLAY` service `whatif`), dan yatim yang lebih muda dari 30 menit (`CLEANUP_MIN_AGE_SEC`) selalu dilindungi. Yatim yang tidak dikenali hanya ditampilkan (tidak dicentang). Server memeriksa ulang tiap PID (termasuk waktu mulainya) sebelum mengirim SIGTERM, lalu SIGKILL setelah 5 detik; tiap tindakan dicatat di `~/cron/dashboard-cleanup.log`.
  Tombol **Restart service** (`POST /api/service/restart`) menjalankan `systemctl --user restart dashboard-gitgit` setelah memastikan unit masih `active` (kalau tidak, permintaan ditolak 409 supaya tidak memicu unit gagal start berulang). Balasan HTTP dikirim dulu, baru perintahnya dijalankan 800 ms kemudian dengan `--no-block` dan `detached` supaya klien sempat menerima balasan dan `systemctl` tidak ikut terbunuh saat unit dihentikan. Konsekuensinya sama seperti restart manual: terminal web tertutup, sesi login berakhir, dan run MiMo yang sedang berjalan disambung otomatis saat service hidup. UI menunggu server benar-benar berhenti lalu hidup lagi sebelum menganggap restart sukses.
- **Folder** — daftar isi disk server, pratinjau, dan unduh
- **Terminal** — shell login di browser, satu tab per terminal (maks. 16). Sesi dan riwayat tetap hidup saat refresh, logout, atau browser ditutup; hanya tombol **×** (Tutup) yang mematikan shell. Ada mode layar penuh dan bilah tombol Esc/Tab/Ctrl/panah untuk HP.
- **Remote Claude** — satu kartu per repo git di `~/github-repos` (`REMOTE_REPOS_DIR`). Tombol **Mulai sesi remote** membuka terminal di root project dan menjalankan `claude remote-control --name <repo>` (sama seperti mengetik manual), sehingga sesinya bisa dipakai dari aplikasi Claude di HP. Status aktif dibaca dari proses `claude remote-control` (folder kerjanya), link `claude.ai/code?environment=…` dan kapasitas dari layar terminal. Klik ganda tidak membuat sesi ganda; **Matikan** menghentikan proses claude-nya (terminal ikut ditutup bila dibuat dari tab ini). Modul: `remote-claude.js`.
- **Log** — riwayat run scraper katalog (cron tiap 30 menit) dan log mentah `~/cron/scraper/scraper.log` dengan saringan dan muat ulang otomatis.
- **CCTV** — rekaman per jam di `/mnt/cctv/<tanggal>/`; pilih tanggal, putar langsung di browser (bisa di-seek, endpoint mendukung HTTP Range), atau unduh.
- **Sosmed** — satu sub-tab per platform, hanya akun yang sedang difokuskan (`SOSMED_FOCUS` di `server.js`: Instagram = @gitgit_infogame dan @kaidankakara; statistik dihitung ulang dari riwayat akun itu):
  - **Instagram** — sub-tab per konten: **Info Game** (@gitgit_infogame) dan **Kai & Kak Ara** (@kaidankakara), masing-masing dengan jadwal hari ini, riwayat posting, link postingan, dan error sendiri (`?account=`). Data dibaca dari API `scraper-social-api`; isi `SOCIAL_API_KEY` (dan opsional `SOCIAL_API_URL`, default `http://172.18.0.1:8791`) di `.env`.
  - **TikTok & Facebook** — dihentikan 27 Nov 2026 (fokus Instagram dan YouTube): tab-nya dihapus dan penjadwal posting TikTok dimatikan. Modul `tiktok.js` beserta rute login/callback GitGit Studio tetap ada supaya app TikTok yang terdaftar tidak rusak; posting Facebook Kai & Kak Ara dimatikan di `social_accounts.json` (scraper-data-gitgit).
  - **YouTube** — dua pipeline, masing-masing dengan sub-tab pemantauannya sendiri (ringkasan, riwayat video, log service):
    - **Apa yang terjadi jika** — dari `whatif-automation` (jadwal harian, link preview publik, log service). Isi `WHATIF_API_TOKEN` (opsional `WHATIF_API_URL`, default `http://172.18.0.1:8798`) di `.env`.
    - **Gitgit Stand-up** — outbox video `gitgit_standup` yang diposting n8n ke YouTube tiap hari 19:00 WIB (status outbox, riwayat video + thumbnail, log harian). Isi `STANDUP_API_TOKEN` (opsional `STANDUP_API_URL`, default `http://172.18.0.1:8797`) di `.env` — token yang sama dengan `.env` `gitgit_standup`.
- **Apps and Games** (grup Produk) — aplikasi milik sendiri (modul `apps.js`, daftar di `APPS`). Untuk Valoid Hub: versi dari `app/build.gradle.kts`, commit sejak kartu Info developer terakhir, dan semua kartu yang sedang tayang di Firestore `announcements/`. **Buat draf Info developer** menjalankan `claude -p` (path `CLAUDE_BIN`, default `~/.local/bin/claude`) di repo aplikasi untuk menulis kartu dari commit; bila gagal memakai template dari judul commit. Draf bisa diedit, dipratinjau seperti di aplikasi, lalu **Posting ke Firestore** (atau **Hapus** kartu lama). Firestore diakses dengan login `firebase-tools` di server (`~/.config/configstore/firebase-tools.json`), sama seperti `tools/post_announcement.py` di valoid-mobile. API: `GET /api/apps`, `GET /api/apps/:id/icon`, `POST /api/apps/:id/draft`, `POST /api/apps/:id/announcements`, `POST /api/apps/:id/announcements/delete`.

### Panel GitGit Studio (https://studio.gitgitdev.my.id/app)

Wajah publik integrasi TikTok, di domain yang terdaftar di app TikTok (dipakai untuk video demo review). Tunnel
meneruskan `studio.gitgitdev.my.id/app*` ke server ini; halaman `studio/index.html` + `/app/api/tiktok/*` +
`/app/callback`. Host itu tidak di balik Cloudflare Access, jadi punya password sendiri (`STUDIO_PASSWORD` di `.env`,
minimal 12 karakter), batas 5 percobaan login per IP per 15 menit, dan sesinya hanya bisa memakai endpoint TikTok.
Redirect URI yang harus terdaftar di app TikTok: `https://studio.gitgitdev.my.id/app/callback` dan
`https://dashboard.gitgitmiko.my.id/agen/api/tiktok/callback`.
