# 📱 PresensiQR — Sistem Presensi Digital QR Code v2.0

Versi ini menggunakan **NeDB** (pure JavaScript database) — tidak butuh compile,
tidak butuh Windows SDK, tidak butuh Visual Studio. Langsung jalan di semua OS.

---

## 🚀 Cara Install & Jalankan (Windows / Mac / Linux)

### 1. Pastikan Node.js sudah terinstall
```
node --version   ← harus muncul v18.x / v20.x / v22.x
```
Download: https://nodejs.org (pilih LTS)

### 2. Buka folder project di CMD / Terminal
```
cd C:\xampp\htdocs\presensi-qr
```

### 3. Install dependencies (sekali saja)
```
npm install --ignore-scripts
```
> ⚠️ Wajib pakai `--ignore-scripts` agar tidak ada proses compile C++

### 4. Jalankan server
```
npm start
```

Muncul pesan:
```
╔════════════════════════════════════════╗
║      ✅ PresensiQR System Ready!       ║
╠════════════════════════════════════════╣
║  http://localhost:3000/scan            ║
║  http://localhost:3000/admin/login     ║
║  Login: admin@presensi.ac.id          ║
║  Pass : admin123                      ║
╚════════════════════════════════════════╝
```

### 5. Buka browser
- **Halaman Scan:** http://localhost:3000/scan
- **Login Admin:**  http://localhost:3000/admin/login

---

## 🔐 Login Default Admin
| | |
|---|---|
| Email    | admin@presensi.ac.id |
| Password | admin123 |

---

## 📋 Fitur Lengkap
- ✅ Scan QR Code via kamera browser
- ✅ Tampil foto, nama, NIY, divisi setelah scan
- ✅ Presensi masuk dan pulang dalam satu hari
- ✅ Scan pertama otomatis menjadi presensi masuk, scan kedua otomatis menjadi presensi pulang
- ✅ Scan ketiga pada hari yang sama ditolak agar data jam pulang tidak berubah
- ✅ Cegah presensi duplikat setelah masuk dan pulang tercatat
- ✅ Dashboard dengan statistik & grafik
- ✅ Manajemen pengguna (tambah/edit/hapus)
- ✅ Upload foto profil
- ✅ Generate & regenerate QR Code
- ✅ Download QR Code (PNG)
- ✅ Filter & cari data presensi
- ✅ Export Excel (.xlsx) berbagai format
- ✅ Pengaturan batas jam & timezone

---

## ⚠️ Jangan tutup CMD saat menggunakan sistem
Server berjalan di CMD/Terminal. Kalau ditutup, sistem mati.

---

## 🔐 HTTPS untuk Scan Kamera dari HP / Laptop Lain

Browser hanya mengizinkan akses kamera melalui **secure context** (HTTPS), dengan pengecualian khusus untuk `localhost`. Karena halaman scan dibuka melalui alamat LAN seperti `192.168.x.x`, gunakan HTTPS.

### Cara paling mudah di Windows

1. Install `mkcert` dari PowerShell **Run as Administrator**:
```powershell
winget install FiloSottile.mkcert
```

2. Tutup PowerShell, buka kembali, lalu dari folder project jalankan:
```powershell
mkcert -install
```

3. Klik dua kali:
```text
START_HTTPS.bat
```

Script akan membuat sertifikat sesuai IP LAN laptop dan menjalankan server HTTPS pada port `3000`.

4. Gunakan alamat yang dicetak di terminal, contoh:
```text
https://192.168.100.23:3000/scan
```

5. Pada perangkat lain (HP/laptop), install `rootCA.pem` dari folder yang ditampilkan oleh:
```powershell
mkcert -CAROOT
```

**Jangan pernah membagikan `rootCA-key.pem`.** Hanya `rootCA.pem` yang dipasang pada perangkat klien.

6. Setelah sertifikat dipercaya, buka halaman HTTPS dan pilih **Izinkan** ketika browser meminta akses kamera.

### Catatan

- Laptop server dan HP/laptop scanner harus berada pada jaringan yang sama.
- Jika IP laptop berubah, jalankan `START_HTTPS.bat` lagi agar sertifikat dibuat untuk IP terbaru.
- Tanpa HTTPS, halaman masih dapat dibuka melalui HTTP, tetapi kamera pada alamat LAN dapat ditolak browser.

## 👩‍🏫 Modul Guru/Karyawan & Gaji
- ✅ Data Guru/Karyawan: nama, NIY, jabatan, status Guru/Karyawan, No. HP/WhatsApp, gaji pokok, tunjangan, username login, QR Code.
- ✅ Menu **Gaji Bulanan** di panel Admin.
- ✅ Periode gaji **1–akhir bulan** (default) atau **26–25**.
- ✅ Potongan keterlambatan dan pulang awal otomatis berdasarkan aturan Pengaturan.
- ✅ Potongan manual hanya dapat diisi **Admin**; guru/karyawan tidak mempunyai akun payroll sendiri.
- ✅ Export rekap gaji ke Excel.
- ✅ Link Google Form izin dan Apps Script tersimpan di Pengaturan.
- ✅ Data dummy testing tersedia di folder `testing/` dalam format CSV dan XLSX.

### Aturan default testing
- Masuk resmi: 07:30
- Pulang resmi: 16:00
- Toleransi: 15 menit
- Pulang lebih awal: dihitung
- Potongan terlambat: Rp1.000/menit
- Potongan pulang awal: Rp1.000/menit

> **Penting:** nilai di atas adalah default testing, bukan klaim aturan resmi sekolah. Ubah di menu **Pengaturan** sesuai aturan sekolah/SK.

## 🔧 Perbaikan Google Form Izin — Error "bukan JSON" / "doGet tidak ditemukan"

Jika menu **Pengajuan Izin → Ambil Data Google Form** menampilkan error `Respons Google Apps Script bukan JSON yang dapat dibaca` atau `Script function not found: doGet`, berarti URL Apps Script belum menyediakan endpoint `doGet()` yang mengembalikan JSON.

Paket ini menyertakan file **GOOGLE_APPS_SCRIPT_IZIN.gs** yang siap ditempel ke project Apps Script yang memiliki akses ke Google Form izin.

Langkah:
1. Buka project Google Apps Script yang digunakan untuk Form izin.
2. Salin isi `GOOGLE_APPS_SCRIPT_IZIN.gs` ke file Apps Script (atau buat file baru `Code.gs`).
3. Pastikan `FORM_ID` sesuai ID Form: `1DzaTq9pjw5rCAEZD_y4vRYbtn8RXNUyrcy3DxxZ08po`.
4. **Deploy → New deployment → Web app**.
5. Execute as: **Me** (pemilik script).
6. Atur akses Web app sesuai jaringan/penggunaan sekolah, lalu salin URL yang berakhiran `/exec` ke **Pengaturan → Google Apps Script Izin**.
7. Klik **Ambil Data Google Form** lagi.

Script membaca respons Google Form langsung dan mengembalikan JSON yang dipahami sistem. Sistem juga tetap mendukung format JSON array maupun objek `{data:[...]}`, `{responses:[...]}`, atau `{rows:[...]}`.

## Export PDF Rekap Gaji & Absensi
- **Export PDF Semua**: membuat satu file PDF dengan **1 lembar A4 untuk setiap Guru/Karyawan**.
- **PDF per orang**: tombol PDF pada kolom Aksi membuat satu lembar A4 khusus orang tersebut.
- Isi PDF: identitas (Nama, NIY, Jabatan, Status), periode, jam kerja/toleransi, ringkasan absensi, rincian gaji (pokok, tunjangan, potongan terlambat, potongan pulang awal, potongan manual, total potongan, gaji bersih), dan detail absensi harian.
- Slip PDF mencantumkan blok tanda tangan di pojok kanan bawah: tempat, tanggal (otomatis tanggal 2 bulan berikutnya), Bendahara Sekolah, garis tanda tangan, dan nama bendahara yang dapat diatur di menu Pengaturan.

## Pembaruan Penggajian

Menu **Gaji Bulanan** sekarang menyediakan **Hasil Akhir Penggajian** yang mengikuti format bukti penerimaan gaji/honorarium: honorarium, tunjangan per komponen, jumlah/jam wajib/kelebihan jam, HR per jam, transport, pendapatan lain, potongan, jumlah kotor, total potongan, dan penerimaan bersih.

Alur penggunaan:
1. Login Admin.
2. Buka **Gaji Bulanan** dan pilih periode.
3. Klik ikon kuitansi pada pegawai untuk membuka **Detail Hasil Akhir Penggajian**.
4. Isi komponen sesuai slip sekolah, lalu **Simpan Hasil Penggajian**.
5. Klik **Cetak Slip** untuk menghasilkan PDF dengan format bukti penerimaan gaji/honorarium.

Potongan keterlambatan dan pulang awal tetap dihitung otomatis dari data presensi.
