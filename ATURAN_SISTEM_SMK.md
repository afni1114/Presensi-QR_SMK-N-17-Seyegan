# Aturan Sistem Presensi & Gaji SMK

Dokumen ini adalah **aturan default yang bisa diubah Admin** pada menu **Pengaturan**. Nilai jam kerja, toleransi, dan tarif potongan harus disesuaikan dengan SK/ketentuan resmi sekolah sebelum dipakai sebagai payroll resmi.

## 1. Data Guru/Karyawan
Field utama yang disiapkan di database:
- Nama
- NIY
- Jabatan
- Status: Guru / Karyawan
- Gaji Pokok (dummy/nominal kontrak)
- Tunjangan
- No. HP / WhatsApp
- Username login (data)
- Password login disimpan sebagai hash bila diisi
- QR Code, status akun, kontak, unit kerja

Sistem saat ini hanya memiliki **1 aktor: Administrator**. Username/password guru-karyawan belum dipakai sebagai jalur login.

## 2. Aturan Absensi
Default yang disiapkan:
- Jam kerja masuk resmi: **07:30**
- Jam kerja pulang resmi: **16:00**
- Toleransi keterlambatan: **15 menit**
- Wajib scan masuk dan scan pulang: **Ya**
- Pulang lebih awal: **dihitung** secara default dan bisa dimatikan Admin
- Lupa absen pulang: kolom jam pulang tetap kosong sampai dikoreksi Admin; jangan membuat jam pulang fiktif
- Izin: melalui **Google Form izin** yang disimpan pada menu Pengaturan

Catatan: jam dan aturan di atas adalah placeholder implementasi karena aturan resmi sekolah belum diberikan di percakapan. Silakan isi sesuai peraturan sekolah.

## 3. Aturan Gaji
Rumus default:

**Gaji Bersih = Gaji Pokok + Tunjangan − Potongan Terlambat − Potongan Pulang Awal − Potongan Manual**

Default tarif testing:
- Potongan keterlambatan: **Rp1.000/menit**
- Potongan pulang awal: **Rp1.000/menit**
- Potongan manual: diinput **Admin** dan boleh Rp0/kosong

Periode gaji dapat dipilih:
- **Tanggal 1 sampai akhir bulan** (default)
- **Tanggal 26 sampai 25 bulan berikutnya**

Rekap keterlambatan mengikuti rentang periode gaji aktif.

## 4. Google Form Izin
URL yang diberikan pengguna disimpan sebagai konfigurasi sistem:

Form:
https://docs.google.com/forms/d/1DzaTq9pjw5rCAEZD_y4vRYbtn8RXNUyrcy3DxxZ08po/edit?pli=1

Apps Script:
https://script.google.com/macros/s/AKfycbzhTxkx8WdXfBQBxEVV9Ro1Cb3axnLLyV9Z7qZRcOQlCxdYtiA0On_YszwvxrxOscYr/exec

Untuk penggunaan guru/karyawan, idealnya gunakan URL **responden/pengisian** Google Form, bukan URL `/edit` milik pembuat Form.

## Alur Pengajuan Izin
1. Guru/Karyawan mengisi Google Form izin.
2. Administrator membuka menu **Pengajuan Izin**.
3. Klik **Ambil Data Google Form** untuk menarik data dari Google Apps Script yang tersimpan pada Pengaturan.
4. Status awal pengajuan adalah **Menunggu**.
5. Administrator memilih **Setujui** atau **Tolak**, serta dapat menambahkan catatan.
6. Setelah validasi, Admin dapat menekan ikon WhatsApp untuk membuka pesan hasil validasi ke nomor WhatsApp tujuan yang diatur pada **Pengaturan → Nomor WhatsApp Notifikasi Izin**.

### Catatan WhatsApp
Sistem memakai tautan WhatsApp (`wa.me`) agar dapat dijalankan tanpa menyimpan kredensial WhatsApp API. Pesan sudah dibuat otomatis; Admin tinggal menekan tombol **Kirim via WhatsApp** dan mengirimkannya.

### Format Data Google Apps Script
Endpoint dapat mengembalikan array JSON langsung atau objek dengan properti `data`, `responses`, atau `rows`. Field yang umum didukung antara lain `nama`, `NIY`, `jenis_izin`, `tanggal_mulai`, `tanggal_selesai`, `alasan`, `no_hp`, dan `timestamp`.
