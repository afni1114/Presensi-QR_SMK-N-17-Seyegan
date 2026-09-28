/**
 * app.js — PresensiQR System
 * Express.js + NeDB (pure JS, no native compile)
 * Compatible: Windows / Mac / Linux — no build tools needed
 */

const express  = require('express');
const http     = require('http');
const https    = require('https');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const QRCode   = require('qrcode');
const xlsx     = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const moment   = require('moment');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');

const { admins, users, attendances, settings, payrolls, leaveRequests,
        findOne, find, findLimit, insert, update, remove, count, ready } = require('./database/db');

const app = express();

// ── Middleware ───────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), {
  setHeaders: (res, filePath) => { if (filePath.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml'); }
}));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js',  express.static(path.join(__dirname, 'public/js')));
app.use(session({
  secret: 'presensi-qr-secret-amikom-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.HTTPS === '1', maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Multer ───────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public/uploads/photos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `photo_${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|jpg|png|webp|gif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('File harus berupa gambar'));
  }
});

// ── Auth Middleware ──────────────────────────────────
const requireAuth = (req, res, next) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  next();
};

// ── Helpers ──────────────────────────────────────────
async function getSetting(key) {
  const row = await findOne(settings, { key });
  return row ? row.value : null;
}

function normalizePhone(phone) {
  let p = String(phone || '').trim().replace(/[^0-9+]/g, '');
  if (p.startsWith('+62')) p = '0' + p.slice(3);
  if (p.startsWith('62')) p = '0' + p.slice(2);
  return p;
}

function waDigits(phone) {
  let p = normalizePhone(phone).replace(/^0+/, '');
  return p ? '62' + p : '';
}

function fmtDate(value) {
  if (!value) return '';
  const m = moment(String(value));
  return m.isValid() ? m.format('DD/MM/YYYY') : String(value);
}

function firstValue(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') return obj[key];
  }
  return '';
}

async function fetchLeaveSource() {
  const url = await getSetting('izin_script_url');
  if (!url) throw new Error('URL Google Apps Script belum diatur.');
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json,text/plain,*/*' },
    redirect: 'follow'
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Apps Script mengembalikan HTTP ${response.status}.`);
  let payload;
  try {
    payload = JSON.parse(text.replace(/^\uFEFF/, '').trim());
  } catch (e) {
    const snippet = String(text).replace(/\s+/g, ' ').slice(0, 220);
    if (/Script function not found: doGet/i.test(text)) {
      throw new Error('Google Apps Script belum memiliki fungsi doGet(). Salin file GOOGLE_APPS_SCRIPT_IZIN.gs ke Apps Script, pilih Deploy > New deployment > Web app, lalu gunakan URL /exec hasil deployment.');
    }
    if (/sign in|access denied|permission|not authorized/i.test(text)) {
      throw new Error('Google Apps Script meminta izin/login. Pastikan Web app dideploy sebagai akun pemilik dan Who has access diizinkan sesuai kebutuhan.');
    }
    throw new Error(`Respons Google Apps Script bukan JSON yang dapat dibaca. Respons: ${snippet}`);
  }
  if (payload && payload.success === false) throw new Error(payload.message || 'Google Apps Script mengembalikan error.');
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.responses) ? payload.responses : (Array.isArray(payload.rows) ? payload.rows : [])));
  if (!Array.isArray(list)) throw new Error('Format data Google Apps Script tidak didukung.');
  return list;
}

function normalizeLeaveRow(row, index) {
  const name = firstValue(row, ['nama','Nama','nama_lengkap','Nama Lengkap','name','Name']);
  const identifier = firstValue(row, ['niy','NIY','NIP','NIK','id','ID','nip','nik']);
  const type = firstValue(row, ['jenis_izin','Jenis Izin','Jenis izin','jenis izin','keperluan','Keperluan','type','Type']) || 'Izin';
  const start = firstValue(row, ['tanggal_mulai','Tanggal Mulai','Tanggal mulai','tanggal','Tanggal','Tanggal Izin','date','Date','Tanggal Mulai Izin']);
  const end = firstValue(row, ['tanggal_selesai','Tanggal Selesai','Tanggal selesai','sampai','Sampai','Tanggal Akhir','Tanggal Selesai Izin']) || start;
  const reason = firstValue(row, ['alasan','Alasan','Alasan Izin','keterangan','Keterangan','Keperluan/Alasan','reason','Reason']);
  const phone = firstValue(row, ['no_hp','No HP','No. HP','No HP/WhatsApp','Nomor HP','Nomor HP/WA','WhatsApp','No. WhatsApp','Nomor WhatsApp','whatsapp','phone','Phone']);
  const submitted = firstValue(row, ['timestamp','Timestamp','Waktu','waktu_pengajuan','Waktu Pengajuan','created_at','createdAt']) || new Date().toISOString();
  const externalId = String(firstValue(row, ['id','ID','response_id','responseId','timestamp','Timestamp']) || `${name}|${identifier}|${start}|${index}`).trim();
  return { external_id: externalId, name: String(name||'Tanpa Nama'), identifier: String(identifier||''), leave_type: String(type), start_date: String(start||''), end_date: String(end||''), reason: String(reason||''), phone: normalizePhone(phone), submitted_at: submitted, source: 'Google Form' };
}

function getOffset(tz) {
  if (tz === 'Asia/Makassar') return '+08:00';
  if (tz === 'Asia/Jayapura') return '+09:00';
  return '+07:00';
}
function getTZLabel(tz) {
  if (tz === 'Asia/Makassar') return 'WITA';
  if (tz === 'Asia/Jayapura') return 'WIT';
  return 'WIB';
}
function getNow(offset) { return moment().utcOffset(offset); }

function idDate(m) {
  const months = ['Januari','Februari','Maret','April','Mei','Juni',
                  'Juli','Agustus','September','Oktober','November','Desember'];
  return `${m.date()} ${months[m.month()]} ${m.year()}`;
}

async function getAttendanceStatus(timeStr) {
  const ontime = (await getSetting('ontime_limit')) || '08:00';
  const tolerance = Number((await getSetting('late_tolerance_minutes')) || 0);
  const [oh, om] = ontime.split(':').map(Number);
  const [th, tm] = timeStr.split(':').map(Number);
  return (th * 60 + tm) <= (oh * 60 + om + tolerance) ? 'Hadir' : 'Terlambat';
}

async function generateQRImage(uuid) {
  const qrDir = path.join(__dirname, 'public/uploads/qrcodes');
  if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
  const qrFile = `qr_${uuid}.png`;
  await QRCode.toFile(path.join(qrDir, qrFile), uuid, {
    color: { dark: '#0f172a', light: '#ffffff' }, width: 300, margin: 2, errorCorrectionLevel: 'H'
  });
  return qrFile;
}

// Join attendance with user data
async function joinAttendanceUser(att) {
  if (!att) return null;
  const u = await findOne(users, { _id: att.user_id });
  return { ...att, name: u?.name||'?', identifier: u?.identifier||'', photo: u?.photo||null,
           position: u?.position||'' };
}

// ════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════

app.get('/', (req, res) => res.redirect('/scan'));

app.get('/scan', async (req, res) => {
  const institution = (await getSetting('institution_name')) || 'Sistem Presensi Digital';
  res.send(renderScanPage(institution));
});

app.post('/api/scan', async (req, res) => {
  try {
    const { qr_data } = req.body;
    if (!qr_data) return res.json({ success: false, message: 'Data QR Code tidak valid.' });

    const user = await findOne(users, { uuid: qr_data.trim() });
    if (!user) return res.json({ success: false, message: 'QR Code tidak valid atau pengguna tidak ditemukan.' });
    if (!user.status) return res.json({ success: false, message: 'Akun pengguna tidak aktif.' });

    const tz = (await getSetting('timezone')) || 'Asia/Jakarta';
    const offset = getOffset(tz);
    const tzLabel = getTZLabel(tz);
    const now = getNow(offset);
    const today = now.format('YYYY-MM-DD');
    const timeNow = now.format('HH:mm:ss');
    const timeShort = timeNow.substring(0, 5);

    const existing = await findOne(attendances, { user_id: user._id, attendance_date: today });

    // Scan pertama = presensi masuk.
    if (!existing) {
      const status = await getAttendanceStatus(timeShort);
      await insert(attendances, {
        user_id: user._id,
        attendance_date: today,
        attendance_time: timeNow,
        attendance_out_time: null,
        status,
        notes: '',
        createdAt: new Date(),
        updatedAt: new Date()
      });

      return res.json({
        success: true,
        type: 'masuk',
        message: 'Presensi masuk berhasil dicatat.',
        user: { name: user.name, identifier: user.identifier, photo: user.photo,
                position: user.position, phone: user.phone, employment_status: user.employment_status },
        attendance: {
          type: 'Masuk', status, date: idDate(now), time: now.format('HH:mm'), timezone: tzLabel
        }
      });
    }

    // Scan kedua = presensi pulang. Scan berikutnya ditolak agar tidak mengganti jam pulang.
    if (!existing.attendance_out_time) {
      await update(attendances, { _id: existing._id }, {
        $set: { attendance_out_time: timeNow, updatedAt: new Date() }
      });

      return res.json({
        success: true,
        type: 'pulang',
        message: 'Presensi pulang berhasil dicatat.',
        user: { name: user.name, identifier: user.identifier, photo: user.photo,
                position: user.position, phone: user.phone, employment_status: user.employment_status },
        attendance: {
          type: 'Pulang', status: existing.status || 'Hadir', date: idDate(now),
          time: now.format('HH:mm'), timezone: tzLabel,
          checkInTime: existing.attendance_time ? existing.attendance_time.substring(0, 5) : null
        }
      });
    }

    return res.json({
      success: false,
      duplicate: true,
      completed: true,
      message: 'Presensi masuk dan pulang hari ini sudah tercatat.',
      user: { name: user.name, identifier: user.identifier, photo: user.photo,
              position: user.position, phone: user.phone, employment_status: user.employment_status },
      existing: {
        checkInTime: existing.attendance_time ? existing.attendance_time.substring(0, 5) : '-',
        checkOutTime: existing.attendance_out_time ? existing.attendance_out_time.substring(0, 5) : '-',
        status: existing.status,
        date: idDate(now)
      }
    });
  } catch(e) {
    console.error(e);
    res.json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ════════════════════════════════════════════════════
// ADMIN AUTH
// ════════════════════════════════════════════════════

app.get('/admin/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin/dashboard');
  res.send(renderLoginPage(req.query.error));
});

app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.redirect('/admin/login?error=1');
  const admin = await findOne(admins, { email });
  if (!admin || !bcrypt.compareSync(password, admin.password)) return res.redirect('/admin/login?error=1');
  req.session.adminId = admin._id;
  req.session.adminName = admin.name;
  res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// ════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════

app.get('/admin/dashboard', requireAuth, async (req, res) => {
  const tz = (await getSetting('timezone')) || 'Asia/Jakarta';
  const offset = getOffset(tz);
  const now = getNow(offset);
  const today = now.format('YYYY-MM-DD');
  const thisMonth = now.format('YYYY-MM');

  const [totalUsers, hadirToday, terlambatToday, bulanIni] = await Promise.all([
    count(users, { status: 1 }),
    count(attendances, { attendance_date: today, status: 'Hadir' }),
    count(attendances, { attendance_date: today, status: 'Terlambat' }),
    count(attendances, { attendance_date: new RegExp('^' + thisMonth) })
  ]);
  const totalPresent = hadirToday + terlambatToday;
  const tidakHadir = Math.max(0, totalUsers - totalPresent);

  // Recent attendances today
  const todayAtts = await find(attendances, { attendance_date: today }, { updatedAt: -1, createdAt: -1 });
  const recentRaw = todayAtts.slice(0, 10);
  const recent = await Promise.all(recentRaw.map(joinAttendanceUser));

  // Chart: last 7 days
  const chartDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = moment().utcOffset(offset).subtract(i, 'days');
    const dStr = d.format('YYYY-MM-DD');
    const [h, t] = await Promise.all([
      count(attendances, { attendance_date: dStr, status: 'Hadir' }),
      count(attendances, { attendance_date: dStr, status: 'Terlambat' })
    ]);
    chartDays.push({ label: d.format('DD/MM'), hadir: h, terlambat: t });
  }

  // Division stats
  const todayAll = await find(attendances, { attendance_date: today });
  const divMap = {};
  for (const a of todayAll) {
    const u = await findOne(users, { _id: a.user_id });
    const div = u?.division || 'Lainnya';
    divMap[div] = (divMap[div] || 0) + 1;
  }
  const divStats = Object.entries(divMap).map(([division, total]) => ({ division, total }));

  res.send(renderDashboard(req, { totalUsers, hadirToday, terlambatToday, tidakHadir, bulanIni, recent, chartDays, divStats }));
});

// ════════════════════════════════════════════════════
// USER MANAGEMENT
// ════════════════════════════════════════════════════

app.get('/admin/users', requireAuth, async (req, res) => {
  const search = req.query.search || '';
  let allUsers = await find(users, {}, { createdAt: -1 });
  if (search) {
    const s = search.toLowerCase();
    allUsers = allUsers.filter(u =>
      (u.name||'').toLowerCase().includes(s) ||
      (u.identifier||'').toLowerCase().includes(s)
    );
  }
  res.send(renderUsersPage(req, allUsers, search));
});

app.get('/admin/users/add', requireAuth, (req, res) => res.send(renderUserFormPage(req, null)));

app.post('/admin/users/add', requireAuth, upload.single('photo'), async (req, res) => {
  const { name, identifier, phone, position, employment_status, basic_salary, allowance, login_username, login_password } = req.body;
  if (!name || !identifier) return res.redirect('/admin/users/add?error=Data+tidak+lengkap');

  const exists = await findOne(users, { identifier });
  if (exists) return res.redirect('/admin/users/add?error=NIY+sudah+terdaftar');

  const uuid = uuidv4();
  const photo = req.file ? req.file.filename : null;
  const qrFile = await generateQRImage(uuid);

  await insert(users, {
    uuid, name, identifier, phone: phone||null,
    position: position||null, employment_status: employment_status||'Guru',
    basic_salary: Number(basic_salary)||0, allowance: Number(allowance)||0,
    login_username: login_username||null, login_password_hash: login_password ? bcrypt.hashSync(login_password, 10) : null,
    photo, qr_code: qrFile, status: 1, createdAt: new Date(), updatedAt: new Date()
  });
  res.redirect('/admin/users?success=Pengguna+berhasil+ditambahkan');
});

app.get('/admin/users/edit/:id', requireAuth, async (req, res) => {
  const user = await findOne(users, { _id: req.params.id });
  if (!user) return res.redirect('/admin/users');
  res.send(renderUserFormPage(req, user));
});

app.post('/admin/users/edit/:id', requireAuth, upload.single('photo'), async (req, res) => {
  const { name, identifier, phone, position, employment_status, basic_salary, allowance, login_username, login_password } = req.body;
  const user = await findOne(users, { _id: req.params.id });
  if (!user) return res.redirect('/admin/users');
  const photo = req.file ? req.file.filename : user.photo;
  await update(users, { _id: req.params.id }, { $set: {
    name, identifier, phone: phone||null,
    position: position||null,
    employment_status: employment_status||user.employment_status||'Guru', basic_salary: Number(basic_salary)||0, allowance: Number(allowance)||0,
    login_username: login_username||null,
    ...(login_password ? { login_password_hash: bcrypt.hashSync(login_password, 10) } : {}),
    photo, updatedAt: new Date()
  }});
  res.redirect('/admin/users?success=Data+pengguna+berhasil+diperbarui');
});

app.post('/admin/users/delete/:id', requireAuth, async (req, res) => {
  const user = await findOne(users, { _id: req.params.id });
  if (user) {
    if (user.photo) { const p = path.join(__dirname,'public/uploads/photos',user.photo); if(fs.existsSync(p)) fs.unlinkSync(p); }
    if (user.qr_code) { const p = path.join(__dirname,'public/uploads/qrcodes',user.qr_code); if(fs.existsSync(p)) fs.unlinkSync(p); }
    await remove(users, { _id: req.params.id });
    await remove(attendances, { user_id: req.params.id }, { multi: true });
  }
  res.redirect('/admin/users?success=Pengguna+berhasil+dihapus');
});

app.post('/admin/users/toggle/:id', requireAuth, async (req, res) => {
  const user = await findOne(users, { _id: req.params.id });
  if (!user) return res.json({ success: false });
  const newStatus = user.status ? 0 : 1;
  await update(users, { _id: req.params.id }, { $set: { status: newStatus, updatedAt: new Date() } });
  res.json({ success: true, status: newStatus });
});

app.post('/admin/users/regenerate-qr/:id', requireAuth, async (req, res) => {
  const user = await findOne(users, { _id: req.params.id });
  if (!user) return res.json({ success: false });
  if (user.qr_code) { const p = path.join(__dirname,'public/uploads/qrcodes',user.qr_code); if(fs.existsSync(p)) fs.unlinkSync(p); }
  const newUuid = uuidv4();
  const qrFile = await generateQRImage(newUuid);
  await update(users, { _id: req.params.id }, { $set: { uuid: newUuid, qr_code: qrFile, updatedAt: new Date() } });
  res.json({ success: true, qr_code: qrFile });
});

app.get('/admin/users/detail/:id', requireAuth, async (req, res) => {
  const user = await findOne(users, { _id: req.params.id });
  if (!user) return res.redirect('/admin/users');
  const atts = await find(attendances, { user_id: req.params.id }, { attendance_date: -1 });
  const recent = atts.slice(0, 20);
  const totalHadir = atts.filter(a => a.status === 'Hadir').length;
  const totalTerlambat = atts.filter(a => a.status === 'Terlambat').length;
  res.send(renderUserDetailPage(req, user, recent, totalHadir, totalTerlambat));
});

// ════════════════════════════════════════════════════
// ATTENDANCE DATA
// ════════════════════════════════════════════════════

app.get('/admin/attendance', requireAuth, async (req, res) => {
  const { date, month, status: filterStatus, division: filterDiv, search } = req.query;
  let allUsers = await find(users, {});
  let allAtts  = await find(attendances, {}, { attendance_date: -1, attendance_time: -1 });

  // Join & filter
  let records = [];
  for (const a of allAtts) {
    const u = allUsers.find(u => u._id === a.user_id);
    if (!u) continue;
    if (date   && a.attendance_date !== date) continue;
    if (month  && !a.attendance_date.startsWith(month)) continue;
    if (filterStatus && a.status !== filterStatus) continue;
    if (filterDiv && !(u.division||'').toLowerCase().includes(filterDiv.toLowerCase())) continue;
    if (search) {
      const s = search.toLowerCase();
      if (!(u.name||'').toLowerCase().includes(s) && !(u.identifier||'').toLowerCase().includes(s)) continue;
    }
    records.push({ ...a, name: u.name, identifier: u.identifier, photo: u.photo,
                   position: u.position||'' });
  }
  records = records.slice(0, 200);
  res.send(renderAttendancePage(req, records, { date, month, status: filterStatus, division: filterDiv, search }));
});

app.post('/admin/attendance/delete/:id', requireAuth, async (req, res) => {
  await remove(attendances, { _id: req.params.id });
  res.redirect('/admin/attendance?success=Data+presensi+berhasil+dihapus');
});

// EXCEL EXPORT
app.get('/admin/attendance/export', requireAuth, async (req, res) => {
  const { type, date, month, start_date, end_date, division } = req.query;
  const tz = (await getSetting('timezone')) || 'Asia/Jakarta';
  const offset = getOffset(tz);
  const today = getNow(offset).format('YYYY-MM-DD');
  const thisMonth = getNow(offset).format('YYYY-MM');

  let allUsers = await find(users, {});
  let allAtts  = await find(attendances, {}, { attendance_date: -1 });
  let filename = 'Presensi';

  let records = [];
  for (const a of allAtts) {
    const u = allUsers.find(u => u._id === a.user_id);
    if (!u) continue;
    let include = false;
    if (type === 'today')    include = a.attendance_date === today;
    else if (type === 'date' && date)       include = a.attendance_date === date;
    else if (type === 'month' && month)     include = a.attendance_date.startsWith(month);
    else if (type === 'range' && start_date && end_date) include = a.attendance_date >= start_date && a.attendance_date <= end_date;
    else if (type === 'division' && division) include = (u.division||'').toLowerCase().includes(division.toLowerCase());
    else include = a.attendance_date.startsWith(thisMonth);
    if (include) records.push({ ...a, name: u.name, identifier: u.identifier,
      position: u.position||'' });
  }

  if (type === 'today')    filename = `Presensi_${today}`;
  else if (type === 'date' && date)   filename = `Presensi_${date}`;
  else if (type === 'month' && month) filename = `Presensi_${month}`;
  else if (type === 'range')          filename = `Presensi_${start_date}_sd_${end_date}`;
  else if (type === 'division' && division) filename = `Presensi_${division.replace(/ /g,'_')}`;
  else filename = `Presensi_Semua_${thisMonth}`;

  const wsData = [['No','ID','Nama','NIY','Jabatan','Tanggal','Jam Masuk','Jam Pulang','Status','Keterangan']];
  records.forEach((r,i) => wsData.push([
    i+1, r._id||i+1, r.name, r.identifier,
    r.position, r.attendance_date,
    r.attendance_time ? r.attendance_time.substring(0,5) : '',
    r.attendance_out_time ? r.attendance_out_time.substring(0,5) : '',
    r.status, r.notes||''
  ]));

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:5},{wch:20},{wch:25},{wch:15},{wch:25},{wch:15},{wch:12},{wch:10},{wch:10},{wch:12},{wch:20}];
  xlsx.utils.book_append_sheet(wb, ws, 'Data Presensi');
  const buf = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ════════════════════════════════════════════════════
// PAYROLL / GAJI
// ════════════════════════════════════════════════════

function periodBounds(period, payrollPeriod='1-end') {
  const base = moment(period + '-01', 'YYYY-MM-DD');
  if (payrollPeriod === '26-25') {
    const start = base.clone().subtract(1,'month').date(26);
    const end = base.clone().date(25);
    return { start:start.format('YYYY-MM-DD'), end:end.format('YYYY-MM-DD') };
  }
  return { start:base.format('YYYY-MM-DD'), end:base.clone().endOf('month').format('YYYY-MM-DD') };
}
function toMinutes(v) { if (!v) return 0; const [h,m]=String(v).split(':').map(Number); return (h||0)*60+(m||0); }
function money(v) { return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(v)||0); }

app.get('/admin/payroll', requireAuth, async (req,res) => {
  const tz=(await getSetting('timezone'))||'Asia/Jakarta';
  const now=getNow(getOffset(tz));
  const period=req.query.period||now.format('YYYY-MM');
  const pack=await getPayrollRows(period);
  res.send(renderPayrollPage(req,pack.rows,period,{start:pack.start,end:pack.end,latePerMin:pack.latePerMin,earlyPerMin:pack.earlyPerMin,workStart:pack.workStart,workEnd:pack.workEnd,tolerance:pack.tolerance}));
});

function n(v){ return Number(v)||0; }
function payrollRecordDefaults(user, existing){
  const x=existing||{};
  const allowanceKeys=['wakur','kaprog','wali_kelas','piket','laboratorium','perpustakaan','koperasi','bpk','masa_kerja','allowance_other'];
  const hasAllowanceBreakdown=!!existing && (x.allowance_total !== undefined || allowanceKeys.some(k=>x[k] !== undefined));
  const legacyAllowance=hasAllowanceBreakdown ? n(x.allowance_total) : n(user.allowance);
  return {
    honorarium: existing && existing.honorarium !== undefined ? n(existing.honorarium) : n(user.basic_salary),
    wakur: n(x.wakur), kaprog: n(x.kaprog), wali_kelas: n(x.wali_kelas), piket: n(x.piket),
    laboratorium: n(x.laboratorium), perpustakaan: n(x.perpustakaan), koperasi: n(x.koperasi), bpk: n(x.bpk),
    masa_kerja: n(x.masa_kerja), allowance_other: existing && x.allowance_other !== undefined ? n(x.allowance_other) : legacyAllowance,
    total_hours: n(x.total_hours), required_hours: n(x.required_hours),
    overtime_rate: n(x.overtime_rate) || 27500, transport_rate: n(x.transport_rate) || 7500,
    transport_days: n(x.transport_days), other_income: n(x.other_income),
    insurance: n(x.insurance), iht: n(x.iht), cooperative: n(x.cooperative), bon: n(x.bon),
    deduction_other: existing ? n(x.deduction_other) : n(x.manual_deduction),
    notes: x.notes || ''
  };
}
function calculatePayroll(user, existing, lateMinutes, earlyMinutes, latePerMin, earlyPerMin){
  const x=payrollRecordDefaults(user,existing);
  const allowance_total = x.wakur+x.kaprog+x.wali_kelas+x.piket+x.laboratorium+x.perpustakaan+x.koperasi+x.bpk+x.masa_kerja+x.allowance_other;
  const extra_hours = Math.max(0, x.total_hours-x.required_hours);
  const extra_pay = extra_hours*x.overtime_rate;
  const transport = x.transport_days*x.transport_rate;
  const autoLate = lateMinutes*latePerMin, autoEarly=earlyMinutes*earlyPerMin;
  const manual = x.insurance+x.iht+x.cooperative+x.bon+x.deduction_other;
  const gross = x.honorarium+allowance_total+extra_pay+transport+x.other_income;
  const totalDed = autoLate+autoEarly+manual;
  const net = gross-totalDed;
  return {...x, allowance_total, extra_hours, extra_pay, transport, autoLate, autoEarly, manual, gross, totalDed, net};
}

app.get('/admin/payroll/detail', requireAuth, async (req,res) => {
  const period=req.query.period || moment().format('YYYY-MM');
  const userId=req.query.user_id;
  if(!userId) return res.status(400).send('user_id wajib diisi');
  const user=await findOne(users,{_id:userId});
  if(!user) return res.status(404).send('Data pengguna tidak ditemukan');
  const pack=await getPayrollRows(period);
  const row=pack.rows.find(x=>x.u._id===userId);
  if(!row) return res.status(404).send('Data penggajian tidak ditemukan');
  res.send(renderPayrollDetailPage(req,row,period,{start:pack.start,end:pack.end,latePerMin:pack.latePerMin,earlyPerMin:pack.earlyPerMin}));
});

app.post('/admin/payroll/detail/save', requireAuth, async (req,res) => {
  const {period,user_id,notes}=req.body;
  const user=await findOne(users,{_id:user_id});
  if(!user) return res.redirect('/admin/payroll?error=Pengguna+tidak+ditemukan');
  const fields=['honorarium','wakur','kaprog','wali_kelas','piket','laboratorium','perpustakaan','koperasi','bpk','masa_kerja','allowance_other','total_hours','required_hours','overtime_rate','transport_rate','transport_days','other_income','insurance','iht','cooperative','bon','deduction_other'];
  const data={period,user_id,user_period:`${user_id}__${period}`,updatedAt:new Date(),updated_by:req.session.adminId,notes:notes||''};
  for(const f of fields) data[f]=Math.max(0,n(req.body[f]));
  data.allowance_total=data.wakur+data.kaprog+data.wali_kelas+data.piket+data.laboratorium+data.perpustakaan+data.koperasi+data.bpk+data.masa_kerja+data.allowance_other;
  data.manual_deduction=data.insurance+data.iht+data.cooperative+data.bon+data.deduction_other;
  const ex=await findOne(payrolls,{user_id,period});
  if(ex) await update(payrolls,{_id:ex._id},{$set:data});
  else await insert(payrolls,{...data,createdAt:new Date()});
  res.redirect(`/admin/payroll/detail?period=${encodeURIComponent(period)}&user_id=${encodeURIComponent(user_id)}&success=Data+penggajian+berhasil+disimpan`);
});

app.post('/admin/payroll/save', requireAuth, async (req,res) => {
  const {period,user_id,manual_deduction,notes}=req.body;
  const user=await findOne(users,{_id:user_id});
  if(!user) return res.redirect('/admin/payroll?error=Pengguna+tidak+ditemukan');
  const value=Math.max(0,n(manual_deduction));
  const ex=await findOne(payrolls,{period,user_id});
  if(ex) await update(payrolls,{_id:ex._id},{$set:{deduction_other:value,manual_deduction:value,notes:notes||'',updatedAt:new Date(),updated_by:req.session.adminId,user_period:`${user_id}__${period}`}});
  else await insert(payrolls,{period,user_id,user_period:`${user_id}__${period}`,deduction_other:value,manual_deduction:value,notes:notes||'',updatedAt:new Date(),createdAt:new Date(),updated_by:req.session.adminId});
  res.redirect('/admin/payroll?period='+encodeURIComponent(period)+'&success=Potongan+lain-lain+berhasil+disimpan');
});

app.get('/admin/payroll/whatsapp', requireAuth, async (req,res) => {
  const period=req.query.period || getNow(getOffset((await getSetting('timezone'))||'Asia/Jakarta')).format('YYYY-MM');
  const userId=req.query.user_id;
  if(!userId) return res.redirect(`/admin/payroll?period=${encodeURIComponent(period)}&error=${encodeURIComponent('Data pengguna tidak ditemukan')}`);
  const r=await findOne(users,{_id:userId});
  if(!r) return res.redirect(`/admin/payroll?period=${encodeURIComponent(period)}&error=${encodeURIComponent('Data pengguna tidak ditemukan')}`);
  const target=waDigits(r.phone);
  if(!target) return res.redirect(`/admin/payroll?period=${encodeURIComponent(period)}&error=${encodeURIComponent(`Nomor WhatsApp ${r.name} belum diisi. Silakan lengkapi di Data Pengguna.`)}`);
  const pack=await getPayrollRows(period);
  const row=pack.rows.find(x=>x.u._id===userId);
  if(!row) return res.redirect(`/admin/payroll?period=${encodeURIComponent(period)}&error=${encodeURIComponent('Data penggajian tidak ditemukan')}`);
  const d=calculatePayroll(row.u,row.existing,row.lateMinutes,row.earlyMinutes,pack.latePerMin,pack.earlyPerMin);
  const meta=periodBounds(period,(await getSetting('payroll_period'))||'1-end');
  const message=[
    'PRESENSIQR - NOTIFIKASI GAJI',
    `Periode: ${period}`,
    `Nama: ${r.name}`,
    `NIY: ${r.identifier||'-'}`,
    `Jabatan: ${r.position||'-'}`,
    `Honorarium: ${money(d.honorarium)}`,
    `Tunjangan: ${money(d.allowance_total)}`,
    `Kelebihan Jam: ${d.extra_hours} jam (${money(d.extra_pay)})`,
    `Transport: ${money(d.transport)}`,
    `Pendapatan Lain: ${money(d.other_income)}`,
    `Jumlah Kotor: ${money(d.gross)}`,
    `Total Potongan: ${money(d.totalDed)}`,
    `Penerimaan Bersih: ${money(d.net)}`,
    `Periode kerja: ${meta.start} s/d ${meta.end}`
  ].join('\n');
  res.redirect(`https://wa.me/${target}?text=${encodeURIComponent(message)}`);
});

app.get('/admin/payroll/export', requireAuth, async (req,res) => {
  const period=req.query.period || getNow(getOffset((await getSetting('timezone'))||'Asia/Jakarta')).format('YYYY-MM');
  const pack=await getPayrollRows(period);
  const data=[['No','NIY','Nama','Jabatan','Status','Honorarium','Wakur','Kaprog','Wali Kelas','Piket','Laboratorium/Bengkel','Perpustakaan','Koperasi','BPK','Masa Kerja','Tunjangan Lain','Jumlah Jam','Jam Wajib','Kelebihan Jam','HR Kelebihan Jam','Transport','Lain-lain','Jumlah Kotor','Pot. Terlambat','Pot. Pulang Awal','Asuransi','IHT','Koperasi','Bon','Pot. Lain','Total Potongan','Penerimaan Bersih']];
  let i=0;
  for(const r of pack.rows){
    const d=calculatePayroll(r.u,r.existing,r.lateMinutes,r.earlyMinutes,pack.latePerMin,pack.earlyPerMin);
    data.push([++i,r.u.identifier,r.u.name,r.u.position||'',r.u.employment_status||'',d.honorarium,d.wakur,d.kaprog,d.wali_kelas,d.piket,d.laboratorium,d.perpustakaan,d.koperasi,d.bpk,d.masa_kerja,d.allowance_other,d.total_hours,d.required_hours,d.extra_hours,d.extra_pay,d.transport,d.other_income,d.gross,d.autoLate,d.autoEarly,d.insurance,d.iht,d.cooperative,d.bon,d.deduction_other,d.totalDed,d.net]);
  }
  const wb=xlsx.utils.book_new(), ws=xlsx.utils.aoa_to_sheet(data); ws['!cols']=data[0].map((_,idx)=>({wch:Math.min(28,Math.max(12,String(data[0][idx]).length+2))})); xlsx.utils.book_append_sheet(wb,ws,'Gaji '+period); const buf=xlsx.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Disposition',`attachment; filename="Rekap_Gaji_${period}.xlsx"`); res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.send(buf);
});

function renderPayrollPage(req, rows, period, meta){
  const msg=req.query.success?`<div class="alert alert-success"><i class="fas fa-check-circle"></i> ${decodeURIComponent(req.query.success)}</div>`:(req.query.error?`<div class="alert alert-danger"><i class="fas fa-exclamation-circle"></i> ${decodeURIComponent(req.query.error)}</div>`:'');
  return `${baseHead('Gaji Bulanan')}\n<body class="admin-body">\n${adminSidebar(req,'payroll')}\n<div class="admin-main">\n${adminTopbar(req)}\n<div class="admin-content">\n<div class="page-header"><div><h1 class="page-title">Hasil Akhir Penggajian</h1><p class="page-sub">Periode ${period} · ${meta.start} s/d ${meta.end}</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn-outline" href="/admin/payroll/export?period=${encodeURIComponent(period)}"><i class="fas fa-file-excel"></i> Export Excel</a><a class="btn-outline" href="/admin/payroll/pdf-all?period=${encodeURIComponent(period)}"><i class="fas fa-file-pdf"></i> Cetak Semua Slip</a></div></div>\n${msg}\n<div class="alert alert-info"><i class="fas fa-calculator"></i> Format slip mengikuti bukti penerimaan gaji: honorarium, tunjangan per komponen, jam wajib/kelebihan jam, transport, potongan, hingga penerimaan bersih. Keterlambatan dan pulang awal dihitung otomatis dari presensi.</div>\n<div class="table-card"><div class="table-toolbar"><form method="GET" class="filter-form"><label style="font-weight:600">Periode</label><input type="month" name="period" value="${period}" class="form-control-sm"><button class="btn-search" type="submit"><i class="fas fa-filter"></i> Tampilkan</button></form></div>\n<div class="table-responsive"><table class="data-table"><thead><tr><th>No</th><th>Nama / NIY</th><th>Jabatan</th><th>Honorarium</th><th>Tunjangan</th><th>Jam Lebih</th><th>Jumlah Kotor</th><th>Total Potongan</th><th>Penerimaan Bersih</th><th>Aksi</th></tr></thead><tbody>\n${rows.map((r,i)=>{const d=calculatePayroll(r.u,r.existing,r.lateMinutes,r.earlyMinutes,meta.latePerMin,meta.earlyPerMin);return `<tr><td>${i+1}</td><td><strong>${r.u.name}</strong><br><small>${r.u.identifier}</small></td><td>${r.u.position||'-'}</td><td>${money(d.honorarium)}</td><td>${money(d.allowance_total)}</td><td>${d.extra_hours} jam</td><td><strong>${money(d.gross)}</strong></td><td>${money(d.totalDed)}</td><td><strong>${money(d.net)}</strong></td><td style="white-space:nowrap"><div style="display:flex;flex-direction:column;gap:6px;align-items:center"><div style="display:flex;gap:6px"><a class="btn-action info" href="/admin/payroll/detail?period=${encodeURIComponent(period)}&user_id=${encodeURIComponent(r.u._id)}" title="Detail hasil akhir"><i class="fas fa-receipt"></i></a><a class="btn-action" href="/admin/payroll/pdf?period=${encodeURIComponent(period)}&user_id=${encodeURIComponent(r.u._id)}" title="Cetak slip"><i class="fas fa-file-pdf"></i></a></div><a class="btn-action whatsapp" href="/admin/payroll/whatsapp?period=${encodeURIComponent(period)}&user_id=${encodeURIComponent(r.u._id)}" title="Kirim hasil gaji via WhatsApp" style="background:#dcfce7;color:#16a34a"><i class="fab fa-whatsapp"></i></a></div></td></tr>`}).join('')}\n</tbody></table></div></div></div></div><script src="/js/admin.js"></script></body></html>`;
}

function pdfEscape(text) {
  return String(text ?? '').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E\xA0-\xFF]/g,' ');
}
function pdfMoney(v) { return money(v).replace(/\u00a0/g,' '); }
function makePdfDocument(pages) {
  const objects=[]; const addObj=body=>{objects.push(body);return objects.length;};
  const fontObj=addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); const pageIds=[];
  for(const page of pages){const stream=page.join('\n')+'\n';const contentId=addObj(`<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}endstream`);const pageId=addObj(`<< /Type /Page /Parent PAGES_ID 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentId} 0 R >>`);pageIds.push(pageId);}
  const pagesId=addObj(`<< /Type /Pages /Kids [${pageIds.map(id=>id+' 0 R').join(' ')}] /Count ${pageIds.length} >>`); const catalogId=addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  for(const id of pageIds) objects[id-1]=objects[id-1].replace('PAGES_ID',String(pagesId));
  let pdf='%PDF-1.4\n%âãÏÓ\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets[i+1]=Buffer.byteLength(pdf,'latin1');pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf,'latin1');pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(pdf,'latin1');
}
function pdfText(page,x,y,text,size=9){page.push(`BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj ET`);}
function pdfLine(page,x1,y1,x2,y2){page.push(`${x1} ${y1} m ${x2} ${y2} l S`);}
function buildPayrollPdfPage(r, period, meta, institution, breakdown, signatureMeta={}){
  const page=[]; page.push('0.6 w');
  pdfText(page,145,810,'BUKTI PENERIMAAN GAJI / HONORARIUM',11); pdfText(page,220,794,`BULAN : ${moment(period+'-01').format('MMMM YYYY').toUpperCase()}`,9); pdfLine(page,40,782,555,782);
  pdfText(page,45,760,`NO : ${r.u.identifier||'-'}`,8); pdfText(page,45,742,`NAMA : ${r.u.name}`,9); pdfText(page,340,742,`JABATAN : ${r.u.position||'-'}`,8); pdfLine(page,40,730,555,730);
  const left=45,right=430; let y=708;
  pdfText(page,left,y,'1. HONORARIUM',9); pdfText(page,right,y,pdfMoney(breakdown.honorarium),9); y-=18;
  pdfText(page,left,y,'2. TUNJANGAN',9); y-=15;
  const allowances=[['a. Wakur',breakdown.wakur],['b. Kaprog',breakdown.kaprog],['c. Wali Kelas',breakdown.wali_kelas],['d. Piket',breakdown.piket],['e. Laboratorium / bengkel',breakdown.laboratorium],['f. Perpustakaan',breakdown.perpustakaan],['g. Koperasi',breakdown.koperasi],['h. BPK',breakdown.bpk],['i. Tunjangan Masa Kerja',breakdown.masa_kerja],['j. Tunjangan Lain-lain',breakdown.allowance_other]];
  for(const [label,val] of allowances){pdfText(page,left+5,y,label,8);pdfText(page,right,y,pdfMoney(val),8);y-=14;}
  pdfText(page,left,y,'Jumlah Jam',8);pdfText(page,300,y,`${breakdown.total_hours} Jam`,8);y-=14;
  pdfText(page,left,y,'Pengurangan Jam Wajib',8);pdfText(page,300,y,`${breakdown.required_hours} Jam`,8);y-=14;
  pdfText(page,left,y,'Kelebihan Jam',8);pdfText(page,300,y,`${breakdown.extra_hours} Jam`,8);y-=14;
  pdfText(page,left,y,`HR Rp ${breakdown.overtime_rate.toLocaleString('id-ID')} x`,8);pdfText(page,300,y,`${breakdown.extra_hours} Jam`,8);pdfText(page,right,y,pdfMoney(breakdown.extra_pay),8);y-=14;
  pdfText(page,left,y,`Transport Rp ${breakdown.transport_rate.toLocaleString('id-ID')} x`,8);pdfText(page,300,y,`${breakdown.transport_days}`,8);pdfText(page,right,y,pdfMoney(breakdown.transport),8);y-=14;
  pdfText(page,left,y,'Lain-lain',8);pdfText(page,right,y,pdfMoney(breakdown.other_income),8);y-=12;
  pdfLine(page,260,y,555,y);y-=17;pdfText(page,left,y,'Jumlah Kotor',9);pdfText(page,right,y,pdfMoney(breakdown.gross),9);y-=22;
  pdfText(page,left,y,'3. POTONGAN',9);y-=16;
  const deductions=[['a. Pot. Terlambat',breakdown.autoLate],['b. Pot. Pulang Awal',breakdown.autoEarly],['c. Asuransi',breakdown.insurance],['d. IHT',breakdown.iht],['e. Koperasi',breakdown.cooperative],['f. Bon',breakdown.bon],['g. Lain-lain',breakdown.deduction_other]];
  for(const [label,val] of deductions){pdfText(page,left+5,y,label,8);pdfText(page,right,y,pdfMoney(val),8);y-=14;}
  pdfLine(page,260,y,555,y);y-=18;pdfText(page,left,y,'Total Potongan',9);pdfText(page,right,y,pdfMoney(breakdown.totalDed),9);y-=24;
  pdfText(page,left,y,'Penerimaan Bersih',10);pdfText(page,right,y,pdfMoney(breakdown.net),10);y-=28;
  pdfLine(page,40,y,555,y); y-=18; pdfText(page,40,y,`Periode presensi: ${meta.start} s/d ${meta.end}`,7.5); y-=13; pdfText(page,40,y,`Terlambat ${r.lateMinutes} menit · Pulang awal ${r.earlyMinutes} menit · Kehadiran ${r.attendanceCount} hari`,7.5);
  const signPlace = signatureMeta.place || 'Seyegan';
  const signName = signatureMeta.name || 'Dra. Agnes Sukarnihari';
  const signDate = signatureMeta.dateLabel || moment(period+'-01').add(1,'month').date(2).format('DD MMMM YYYY');
  pdfText(page,380,125,`${signPlace}, ${signDate}`,8);
  pdfText(page,380,108,'Bendahara Sekolah',8);
  pdfText(page,380,72,'____________________',8);
  pdfText(page,380,54,signName,8);
  pdfText(page,40,45,'Dokumen dibuat oleh PresensiQR',7.5);
  return page;
}

async function getPayrollRows(period) {
  const payrollPeriod=(await getSetting('payroll_period'))||'1-end'; const {start,end}=periodBounds(period,payrollPeriod);
  const allUsers=await find(users,{}, {name:1}); const atts=await find(attendances,{attendance_date:{$gte:start,$lte:end}},{attendance_date:1});
  const latePerMin=Number((await getSetting('late_deduction_per_minute'))||1000); const earlyPerMin=Number((await getSetting('early_leave_deduction_per_minute'))||1000);
  const workStart=await getSetting('work_start')||'07:30'; const workEnd=await getSetting('work_end')||'16:00'; const tolerance=Number((await getSetting('late_tolerance_minutes'))||15); const earlyCounted=(await getSetting('early_leave_counted'))!=='0'; const rows=[];
  for(const u of allUsers.filter(x=>x.status!==0)){
    const ua=atts.filter(a=>a.user_id===u._id); let lm=0,em=0,lateDays=0,earlyDays=0,missingOut=0,presentDays=0;
    for(const a of ua){const im=toMinutes(a.attendance_time);const om=toMinutes(a.attendance_out_time);const l=Math.max(0,im-toMinutes(workStart)-tolerance);const e=a.attendance_out_time&&earlyCounted?Math.max(0,toMinutes(workEnd)-om):0;lm+=l;em+=e;if(l>0)lateDays++;if(e>0)earlyDays++;if(!a.attendance_out_time)missingOut++;if(a.status==='Hadir'||a.status==='Terlambat')presentDays++;}
    const existing=await findOne(payrolls,{user_id:u._id,period}); const d=calculatePayroll(u,existing,lm,em,latePerMin,earlyPerMin);
    rows.push({u,existing,attendanceCount:ua.length,presentDays,lateDays,earlyDays,missingOut,lateMinutes:lm,earlyMinutes:em,...d,daily:ua});
  }
  return {rows,start,end,latePerMin,earlyPerMin,workStart,workEnd,tolerance};
}

app.get('/admin/payroll/pdf', requireAuth, async (req,res) => {
  const period=req.query.period || getNow(getOffset((await getSetting('timezone'))||'Asia/Jakarta')).format('YYYY-MM'); const userId=req.query.user_id; if(!userId) return res.status(400).send('user_id wajib diisi');
  const pack=await getPayrollRows(period); const r=pack.rows.find(x=>x.u._id===userId); if(!r) return res.status(404).send('Data pengguna tidak ditemukan'); const institution=await getSetting('institution_name')||'SMK';
  const signPlace=await getSetting('payroll_place')||'Seyegan'; const signName=await getSetting('payroll_treasurer_name')||'Dra. Agnes Sukarnihari';
  const signDate=moment(period+'-01').add(1,'month').date(2).format('DD MMMM YYYY');
  const buf=makePdfDocument([buildPayrollPdfPage(r,period,{start:pack.start,end:pack.end},institution,calculatePayroll(r.u,r.existing,r.lateMinutes,r.earlyMinutes,pack.latePerMin,pack.earlyPerMin),{place:signPlace,name:signName,dateLabel:signDate})]);
  res.setHeader('Content-Disposition',`attachment; filename="Bukti_Gaji_${r.u.identifier||r.u._id}_${period}.pdf"`);res.setHeader('Content-Type','application/pdf');res.send(buf);
});
app.get('/admin/payroll/pdf-all', requireAuth, async (req,res) => {
  const period=req.query.period || getNow(getOffset((await getSetting('timezone'))||'Asia/Jakarta')).format('YYYY-MM'); const pack=await getPayrollRows(period); const institution=await getSetting('institution_name')||'SMK';
  const signPlace=await getSetting('payroll_place')||'Seyegan'; const signName=await getSetting('payroll_treasurer_name')||'Dra. Agnes Sukarnihari';
  const signDate=moment(period+'-01').add(1,'month').date(2).format('DD MMMM YYYY');
  const signMeta={place:signPlace,name:signName,dateLabel:signDate};
  const pages=pack.rows.map(r=>buildPayrollPdfPage(r,period,{start:pack.start,end:pack.end},institution,calculatePayroll(r.u,r.existing,r.lateMinutes,r.earlyMinutes,pack.latePerMin,pack.earlyPerMin),signMeta));
  const buf=makePdfDocument(pages.length?pages:[buildPayrollPdfPage({u:{name:'Tidak ada data',identifier:'-'},lateMinutes:0,earlyMinutes:0,attendanceCount:0},{start:pack.start,end:pack.end},institution,calculatePayroll({basic_salary:0,allowance:0},null,0,0,pack.latePerMin,pack.earlyPerMin),signMeta)]);
  res.setHeader('Content-Disposition',`attachment; filename="Bukti_Gaji_Semua_${period}.pdf"`);res.setHeader('Content-Type','application/pdf');res.send(buf);
});

function renderPayrollDetailPage(req,r,period,meta){
  const d=calculatePayroll(r.u,r.existing,r.lateMinutes,r.earlyMinutes,meta.latePerMin,meta.earlyPerMin); const msg=req.query.success?`<div class="alert alert-success"><i class="fas fa-check-circle"></i> ${decodeURIComponent(req.query.success)}</div>`:'';
  const nf=(name,val,step='1')=>`<input type="number" min="0" step="${step}" name="${name}" class="form-control" value="${val}">`;
  const row=(label,name,val,cls='')=>`<div class="form-group ${cls}"><label>${label}</label>${nf(name,val)}</div>`;
  return `${baseHead('Detail Hasil Penggajian')}\n<body class="admin-body">${adminSidebar(req,'payroll')}<div class="admin-main">${adminTopbar(req)}<div class="admin-content">
  <div class="page-header"><div><h1 class="page-title">Detail Hasil Akhir Penggajian</h1><p class="page-sub">${r.u.name} · ${r.u.identifier} · ${period}</p></div><div style="display:flex;gap:8px"><a href="/admin/payroll?period=${encodeURIComponent(period)}" class="btn-outline"><i class="fas fa-arrow-left"></i> Kembali</a><a href="/admin/payroll/pdf?period=${encodeURIComponent(period)}&user_id=${encodeURIComponent(r.u._id)}" class="btn-outline"><i class="fas fa-file-pdf"></i> Cetak Slip</a></div></div>
  ${msg}
  <form method="POST" action="/admin/payroll/detail/save">
    <input type="hidden" name="period" value="${period}"><input type="hidden" name="user_id" value="${r.u._id}">
    <div class="form-card"><h3 class="section-title">1. Honorarium</h3><div class="form-grid-2">${row('Honorarium / Gaji Pokok','honorarium',d.honorarium)}</div>
    <h3 class="section-title mt-4">2. Tunjangan</h3><div class="form-grid-2">${row('Wakur','wakur',d.wakur)}${row('Kaprog','kaprog',d.kaprog)}${row('Wali Kelas','wali_kelas',d.wali_kelas)}${row('Piket','piket',d.piket)}${row('Laboratorium / Bengkel','laboratorium',d.laboratorium)}${row('Perpustakaan','perpustakaan',d.perpustakaan)}${row('Koperasi','koperasi',d.koperasi)}${row('BPK','bpk',d.bpk)}${row('Tunjangan Masa Kerja','masa_kerja',d.masa_kerja)}${row('Tunjangan Lain-lain','allowance_other',d.allowance_other)}</div>
    <h3 class="section-title mt-4">Jam, Kelebihan Jam & Pendapatan Lain</h3><div class="form-grid-2">${row('Jumlah Jam','total_hours',d.total_hours)}${row('Jam Wajib','required_hours',d.required_hours)}${row('HR per Jam Kelebihan','overtime_rate',d.overtime_rate)}${row('Tarif Transport / Hari','transport_rate',d.transport_rate)}${row('Jumlah Hari Transport','transport_days',d.transport_days)}${row('Lain-lain Pendapatan','other_income',d.other_income)}</div>
    <div class="payroll-summary-grid"><div class="payroll-summary-card"><span>Gaji Kotor</span><strong>${money(d.gross)}</strong></div><div class="payroll-summary-card"><span>Total Potongan</span><strong>${money(d.totalDed)}</strong></div><div class="payroll-summary-card highlight"><span>Penerimaan Bersih</span><strong>${money(d.net)}</strong></div></div>
    <h3 class="section-title mt-4">3. Potongan</h3><div class="form-grid-2">${row('Asuransi','insurance',d.insurance)}${row('IHT','iht',d.iht)}${row('Koperasi','cooperative',d.cooperative)}${row('Bon','bon',d.bon)}${row('Potongan Lain-lain','deduction_other',d.deduction_other)}</div>
    <div class="alert alert-info mt-4"><i class="fas fa-clock"></i> Potongan otomatis presensi bulan ini: Terlambat ${r.lateMinutes} menit = ${money(d.autoLate)}, Pulang awal ${r.earlyMinutes} menit = ${money(d.autoEarly)}.</div>
    <div class="form-group"><label>Catatan</label><textarea name="notes" class="form-control" rows="3" placeholder="Catatan bendahara...">${d.notes||''}</textarea></div>
    <div class="form-actions"><a href="/admin/payroll?period=${encodeURIComponent(period)}" class="btn-outline">Batal</a><button class="btn-primary" type="submit"><i class="fas fa-save"></i> Simpan Hasil Penggajian</button></div>
    </div>
  </form>
  </div></div><script src="/js/admin.js"></script></body></html>`;
}

// ════════════════════════════════════════════════════
// LEAVE / IZIN
// ════════════════════════════════════════════════════

app.get('/admin/leave', requireAuth, async (req, res) => {
  const rows = await find(leaveRequests, {}, { createdAt: -1 });
  const formUrl = await getSetting('izin_form_url');
  res.send(renderLeavePage(req, rows, formUrl));
});

app.post('/admin/leave/manual', requireAuth, async (req, res) => {
  try {
    const { name, identifier, phone, leave_type, start_date, end_date, reason } = req.body;
    if (!name || !start_date || !reason) return res.redirect('/admin/leave?error=Nama%2C+tanggal+mulai%2C+dan+alasan+wajib+diisi');
    const externalId = `MANUAL|${Date.now()}|${name}`;
    await insert(leaveRequests, {
      external_id: externalId,
      name: String(name).trim(),
      identifier: String(identifier || '').trim(),
      leave_type: String(leave_type || 'Izin').trim(),
      start_date: String(start_date),
      end_date: String(end_date || start_date),
      reason: String(reason).trim(),
      phone: normalizePhone(phone),
      submitted_at: new Date().toISOString(),
      source: 'Input Admin',
      status: 'Menunggu',
      admin_note: '',
      reviewed_by: null,
      reviewed_at: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    res.redirect('/admin/leave?success=Pengajuan+izin+manual+berhasil+ditambahkan+dan+menunggu+validasi');
  } catch (e) {
    console.error('MANUAL IZIN:', e);
    res.redirect(`/admin/leave?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/leave/sync', requireAuth, async (req, res) => {
  try {
    const sourceRows = await fetchLeaveSource();
    let added = 0, updated = 0;
    for (let i = 0; i < sourceRows.length; i++) {
      const normalized = normalizeLeaveRow(sourceRows[i], i);
      if (!normalized.name || normalized.name === 'Tanpa Nama') continue;
      const existing = await findOne(leaveRequests, { external_id: normalized.external_id });
      if (existing) {
        await update(leaveRequests, { _id: existing._id }, { $set: { ...normalized, updatedAt: new Date() } });
        updated++;
      } else {
        await insert(leaveRequests, { ...normalized, status: 'Menunggu', admin_note: '', reviewed_by: null, reviewed_at: null, createdAt: new Date(), updatedAt: new Date() });
        added++;
      }
    }
    res.redirect(`/admin/leave?success=${encodeURIComponent(`Sinkronisasi selesai: ${added} data baru, ${updated} data diperbarui.`)}`);
  } catch (e) {
    console.error('SYNC IZIN:', e);
    res.redirect(`/admin/leave?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/leave/:id/status', requireAuth, async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['Disetujui','Ditolak'].includes(status)) return res.redirect('/admin/leave?error=Status+izin+tidak+valid');
  const row = await findOne(leaveRequests, { _id: req.params.id });
  if (!row) return res.redirect('/admin/leave?error=Data+izin+tidak+ditemukan');
  await update(leaveRequests, { _id: req.params.id }, { $set: { status, admin_note: admin_note || '', reviewed_by: req.session.adminId, reviewed_at: new Date(), updatedAt: new Date() } });
  res.redirect(`/admin/leave?success=${encodeURIComponent(`Pengajuan ${row.name} ${status.toLowerCase()}. Silakan kirim hasil melalui WhatsApp.`)}`);
});

app.get('/admin/leave/:id/whatsapp', requireAuth, async (req, res) => {
  const row = await findOne(leaveRequests, { _id: req.params.id });
  if (!row) return res.redirect('/admin/leave?error=Data+izin+tidak+ditemukan');
  const target = waDigits(await getSetting('izin_wa_number'));
  if (!target) return res.redirect('/admin/leave?error=Nomor+WhatsApp+tujuan+belum+diatur');
  const message = [
    'PRESENSIQR - NOTIFIKASI IZIN',
    `Nama: ${row.name}`,
    `NIY: ${row.identifier || '-'}`,
    `Jenis Izin: ${row.leave_type || '-'}`,
    `Tanggal: ${fmtDate(row.start_date)}${row.end_date && row.end_date !== row.start_date ? ` s/d ${fmtDate(row.end_date)}` : ''}`,
    `Alasan: ${row.reason || '-'}`,
    `Status: ${row.status}`,
    `Catatan Admin: ${row.admin_note || '-'}`
  ].join('\\n');
  res.redirect(`https://wa.me/${target}?text=${encodeURIComponent(message)}`);
});

// Webhook opsional untuk Google Apps Script: kirim JSON langsung ke sistem.
app.post('/api/izin/webhook', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body : (Array.isArray(req.body.data) ? req.body.data : [req.body]);
    let saved = 0;
    for (let i = 0; i < payload.length; i++) {
      const normalized = normalizeLeaveRow(payload[i], i);
      const existing = await findOne(leaveRequests, { external_id: normalized.external_id });
      if (existing) await update(leaveRequests, { _id: existing._id }, { $set: { ...normalized, updatedAt: new Date() } });
      else { await insert(leaveRequests, { ...normalized, status: 'Menunggu', admin_note: '', reviewed_by: null, reviewed_at: null, createdAt: new Date(), updatedAt: new Date() }); saved++; }
    }
    res.json({ success: true, saved });
  } catch (e) {
    console.error('WEBHOOK IZIN:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════

app.get('/admin/settings', requireAuth, async (req, res) => {
  const rows = await find(settings, {});
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  res.send(renderSettingsPage(req, s));
});

app.post('/admin/settings', requireAuth, async (req, res) => {
  const { institution_name, ontime_limit, late_limit, work_start, work_end, late_tolerance_minutes, early_leave_counted, late_deduction_per_minute, early_leave_deduction_per_minute, payroll_period, timezone, izin_form_url, izin_script_url, izin_wa_number, payroll_place, payroll_treasurer_name } = req.body;
  const pairs = { institution_name, ontime_limit, late_limit, work_start, work_end, late_tolerance_minutes, early_leave_counted, late_deduction_per_minute, early_leave_deduction_per_minute, payroll_period, timezone, izin_form_url, izin_script_url, izin_wa_number, payroll_place, payroll_treasurer_name };
  for (const [key, value] of Object.entries(pairs)) {
    if (value !== undefined) {
      const ex = await findOne(settings, { key });
      if (ex) await update(settings, { key }, { $set: { value, updatedAt: new Date() } });
      else    await insert(settings, { key, value, updatedAt: new Date() });
    }
  }
  res.redirect('/admin/settings?success=Pengaturan+berhasil+disimpan');
});

// ════════════════════════════════════════════════════
// QR CODE MANAGEMENT
// ════════════════════════════════════════════════════

app.get('/admin/qrcodes', requireAuth, async (req, res) => {
  const allUsers = await find(users, { status: 1 }, { name: 1 });
  res.send(renderQRPage(req, allUsers));
});

app.post('/admin/qrcodes/generate/:id', requireAuth, async (req, res) => {
  const user = await findOne(users, { _id: req.params.id });
  if (!user) return res.json({ success: false });
  if (!user.qr_code) {
    const qrFile = await generateQRImage(user.uuid);
    await update(users, { _id: req.params.id }, { $set: { qr_code: qrFile } });
    return res.json({ success: true, qr_code: qrFile });
  }
  res.json({ success: true, qr_code: user.qr_code });
});

// ════════════════════════════════════════════════════
// HTML RENDERERS
// ════════════════════════════════════════════════════

const baseHead = (title) => `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - PresensiQR</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<link rel="stylesheet" href="/css/style.css">
</head>`;

const adminSidebar = (req, active) => `
<div class="sidebar" id="sidebar">
  <div class="sidebar-brand">
    <div class="brand-logo"><i class="fas fa-qrcode"></i></div>
    <div class="brand-text"><span class="brand-name">PresensiQR</span><span class="brand-sub">Digital System</span></div>
    <button class="sidebar-toggle-close" id="sidebarClose"><i class="fas fa-times"></i></button>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-section">
      <span class="nav-label">Menu Utama</span>
      <a href="/admin/dashboard" class="nav-item ${active==='dashboard'?'active':''}"><i class="fas fa-chart-pie"></i><span>Dashboard</span></a>
      <a href="/scan" class="nav-item" target="_blank"><i class="fas fa-qrcode"></i><span>Halaman Scan</span></a>
    </div>
    <div class="nav-section">
      <span class="nav-label">Data</span>
      <a href="/admin/attendance" class="nav-item ${active==='attendance'?'active':''}"><i class="fas fa-clipboard-list"></i><span>Data Presensi</span></a>
      <a href="/admin/users" class="nav-item ${active==='users'?'active':''}"><i class="fas fa-users"></i><span>Data Pengguna</span></a>
      <a href="/admin/qrcodes" class="nav-item ${active==='qrcodes'?'active':''}"><i class="fas fa-id-card"></i><span>QR Code</span></a>
      <a href="/admin/payroll" class="nav-item ${active==='payroll'?'active':''}"><i class="fas fa-money-check-dollar"></i><span>Gaji Bulanan</span></a>
      <a href="/admin/leave" class="nav-item ${active==='leave'?'active':''}"><i class="fas fa-file-circle-check"></i><span>Pengajuan Izin</span></a>
    </div>
    <div class="nav-section">
      <span class="nav-label">Sistem</span>
      <a href="/admin/settings" class="nav-item ${active==='settings'?'active':''}"><i class="fas fa-cog"></i><span>Pengaturan</span></a>
      <a href="/admin/logout" class="nav-item text-danger"><i class="fas fa-sign-out-alt"></i><span>Logout</span></a>
    </div>
  </nav>
</div>
<div class="sidebar-overlay" id="sidebarOverlay"></div>`;

const adminTopbar = (req) => `
<header class="topbar">
  <div class="topbar-left">
    <button class="topbar-toggle" id="sidebarOpen"><i class="fas fa-bars"></i></button>
    <div class="topbar-breadcrumb"><span>Panel Admin</span></div>
  </div>
  <div class="topbar-right">
    <div class="topbar-time" id="topbarTime"></div>
    <div class="topbar-admin">
      <div class="admin-avatar"><i class="fas fa-user-shield"></i></div>
      <div class="admin-info"><span class="admin-name">${req.session.adminName||'Admin'}</span><span class="admin-role">Administrator</span></div>
    </div>
  </div>
</header>`;

// ── Scan Page ────────────────────────────────────────
function renderScanPage(institution) {
  return `${baseHead('Scan Presensi')}
<body class="scan-body">
<div class="scan-wrapper">
  <header class="scan-header">
    <div class="scan-logo"><i class="fas fa-qrcode"></i></div>
    <div class="scan-brand"><h2>${institution}</h2><p>Sistem Presensi Digital</p></div>
  </header>
  <main class="scan-main">
    <div id="scanView">
      <div class="scan-title-block">
        <h1>Presensi Digital</h1>
        <p>Scan QR Code untuk presensi <strong>masuk</strong> dan <strong>pulang</strong></p>
      </div>
      <div class="qr-container">
        <div class="qr-frame" id="qrFrame">
          <div class="qr-corner tl"></div><div class="qr-corner tr"></div>
          <div class="qr-corner bl"></div><div class="qr-corner br"></div>
          <div class="scan-line" id="scanLine"></div>
          <video id="qrVideo" playsinline autoplay muted></video>
          <canvas id="qrCanvas" style="display:none"></canvas>
        </div>
        <div class="qr-status" id="qrStatus">
          <div class="status-dot active"></div>
          <span>Memulai kamera...</span>
        </div>
        <div class="camera-actions" id="cameraActions" style="display:none">
          <button type="button" class="btn-camera" id="btnStartCamera"><i class="fas fa-camera"></i> Aktifkan Kamera</button>
        </div>
      </div>
      <div class="scan-info-grid">
        <div class="info-card"><i class="fas fa-calendar"></i><div id="scanDate">-</div></div>
        <div class="info-card"><i class="fas fa-clock"></i><div id="scanTime">-</div></div>
      </div>
      <div class="scan-hint"><i class="fas fa-info-circle"></i> Scan pertama = <strong>Masuk</strong> · Scan kedua = <strong>Pulang</strong>. Pastikan QR Code terlihat jelas dan tidak blur.</div>
    </div>
    <div id="resultView" style="display:none">
      <div class="result-card" id="resultCard">
        <div class="result-icon success" id="resultIcon"><i class="fas fa-check"></i></div>
        <div class="result-photo-wrap">
          <img src="" alt="Foto" id="resultPhoto" class="result-photo" style="display:none">
          <div class="result-photo-placeholder" id="resultPhotoPlaceholder"><i class="fas fa-user"></i></div>
        </div>
        <h2 id="resultName">-</h2>
        <div class="result-id" id="resultId">-</div>
        <div class="result-meta-grid">
          <div class="result-meta-item"><span class="meta-label">Jenis Presensi</span><span class="meta-val" id="resultType">-</span></div>
          <div class="result-meta-item"><span class="meta-label">Jabatan</span><span class="meta-val" id="resultPosition">-</span></div>

          <div class="result-meta-item"><span class="meta-label">Status</span><span class="meta-val" id="resultStatus">-</span></div>
          <div class="result-meta-item"><span class="meta-label">Tanggal</span><span class="meta-val" id="resultDate">-</span></div>
          <div class="result-meta-item"><span class="meta-label">Jam</span><span class="meta-val" id="resultTime">-</span></div>
        </div>
        <p class="result-message" id="resultMessage"></p>
        <button class="btn-scan-again" id="btnScanAgain"><i class="fas fa-redo"></i> Scan Lagi</button>
      </div>
    </div>
  </main>
</div>
<script src="/js/jsQR.min.js"></script>
<script src="/js/scan.js"></script>
</body></html>`;
}

// ── Login Page ───────────────────────────────────────
function renderLoginPage(error) {
  return `${baseHead('Login Admin')}
<body class="login-body">
<div class="login-wrapper">
  <div class="login-card">
    <div class="login-logo"><i class="fas fa-qrcode"></i></div>
    <h1 class="login-title">PresensiQR</h1>
    <p class="login-sub">Masuk ke Panel Administrator</p>
    ${error ? '<div class="alert alert-danger"><i class="fas fa-exclamation-circle"></i> Email atau password salah.</div>' : ''}
    <form method="POST" action="/admin/login" class="login-form">
      <div class="form-group">
        <label><i class="fas fa-envelope"></i> Email</label>
        <input type="email" name="email" class="form-control" placeholder="admin@presensi.ac.id" required autocomplete="email">
      </div>
      <div class="form-group">
        <label><i class="fas fa-lock"></i> Password</label>
        <input type="password" name="password" class="form-control" placeholder="••••••••" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn-login"><i class="fas fa-sign-in-alt"></i> Masuk</button>
    </form>
    <p class="login-hint">Default: admin@presensi.ac.id / admin123</p>
  </div>
</div>
</body></html>`;
}

// ── Dashboard ────────────────────────────────────────
function renderDashboard(req, data) {
  const { totalUsers, hadirToday, terlambatToday, tidakHadir, bulanIni, recent, chartDays, divStats } = data;
  return `${baseHead('Dashboard')}
<body class="admin-body">
${adminSidebar(req,'dashboard')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header">
    <div><h1 class="page-title">Dashboard</h1><p class="page-sub">Ringkasan data presensi hari ini</p></div>
  </div>
  <div class="stats-grid">
    <div class="stat-card primary"><div class="stat-icon"><i class="fas fa-users"></i></div><div class="stat-body"><div class="stat-number">${totalUsers}</div><div class="stat-label">Total Pengguna</div></div></div>
    <div class="stat-card success"><div class="stat-icon"><i class="fas fa-user-check"></i></div><div class="stat-body"><div class="stat-number">${hadirToday}</div><div class="stat-label">Hadir Hari Ini</div></div></div>
    <div class="stat-card warning"><div class="stat-icon"><i class="fas fa-clock"></i></div><div class="stat-body"><div class="stat-number">${terlambatToday}</div><div class="stat-label">Terlambat</div></div></div>
    <div class="stat-card danger"><div class="stat-icon"><i class="fas fa-user-times"></i></div><div class="stat-body"><div class="stat-number">${tidakHadir}</div><div class="stat-label">Tidak Hadir</div></div></div>
    <div class="stat-card info"><div class="stat-icon"><i class="fas fa-calendar-check"></i></div><div class="stat-body"><div class="stat-number">${bulanIni}</div><div class="stat-label">Presensi Bulan Ini</div></div></div>
  </div>
  <div class="charts-grid">
    <div class="chart-card"><div class="chart-header"><h3>Kehadiran 7 Hari Terakhir</h3></div><canvas id="chartLine" height="120"></canvas></div>
    <div class="chart-card"><div class="chart-header"><h3>Kehadiran per Divisi</h3></div><canvas id="chartDoughnut" height="120"></canvas></div>
  </div>
  <div class="recent-card">
    <div class="chart-header"><h3>Presensi Terbaru Hari Ini</h3><a href="/admin/attendance" class="btn-sm-link">Lihat Semua</a></div>
    <div class="recent-list">
      ${recent.length === 0
        ? '<p class="empty-msg"><i class="fas fa-inbox"></i><span>Belum ada presensi hari ini</span></p>'
        : recent.map(r => `
        <div class="recent-item">
          <div class="recent-photo">${r.photo ? `<img src="/uploads/photos/${r.photo}" alt="${r.name}">` : `<div class="photo-placeholder"><i class="fas fa-user"></i></div>`}</div>
          <div class="recent-info"><div class="recent-name">${r.name}</div><div class="recent-meta">${r.identifier} · ${r.division||'-'}</div></div>
          <div class="recent-right">
            <span class="badge badge-${r.attendance_out_time?'info':r.status==='Hadir'?'success':r.status==='Terlambat'?'warning':'info'}">${r.attendance_out_time?'Pulang':r.status}</span>
            <div class="recent-time">${r.attendance_out_time ? `Pulang ${(r.attendance_out_time||'').substring(0,5)}` : `Masuk ${(r.attendance_time||'').substring(0,5)}`} WIB</div>
          </div>
        </div>`).join('')}
    </div>
  </div>
</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="/js/admin.js"></script>
<script>
initCharts(
  ${JSON.stringify(chartDays.map(d=>d.label))},
  ${JSON.stringify(chartDays.map(d=>d.hadir))},
  ${JSON.stringify(chartDays.map(d=>d.terlambat))},
  ${JSON.stringify(divStats.map(d=>d.division||'Lainnya'))},
  ${JSON.stringify(divStats.map(d=>d.total))}
);
</script>
</body></html>`;
}

// ── Users Page ───────────────────────────────────────
function renderUsersPage(req, allUsers, search) {
  const msg = req.query.success ? `<div class="alert alert-success"><i class="fas fa-check-circle"></i> ${decodeURIComponent(req.query.success)}</div>` : '';
  return `${baseHead('Data Pengguna')}
<body class="admin-body">
${adminSidebar(req,'users')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header">
    <div><h1 class="page-title">Data Pengguna</h1><p class="page-sub">Kelola seluruh pengguna sistem</p></div>
    <a href="/admin/users/add" class="btn-primary"><i class="fas fa-plus"></i> Tambah Pengguna</a>
  </div>
  ${msg}
  <div class="table-card">
    <div class="table-toolbar">
      <form method="GET" class="search-form">
        <input type="text" name="search" value="${search||''}" placeholder="Cari nama atau NIY..." class="search-input">
        <button type="submit" class="btn-search"><i class="fas fa-search"></i></button>
        ${search ? '<a href="/admin/users" class="btn-clear">Reset</a>' : ''}
      </form>
    </div>
    <div class="table-responsive">
      <table class="data-table">
        <thead><tr><th>No</th><th>Foto</th><th>Nama & NIY</th><th>Jabatan</th><th>Status</th><th>Gaji Pokok</th><th>Tunjangan</th><th>QR Code</th><th>Aksi</th></tr></thead>
        <tbody>
          ${allUsers.length === 0 ? '<tr><td colspan="9" class="empty-cell">Tidak ada data pengguna.</td></tr>' : allUsers.map((u,i) => `
          <tr>
            <td>${i+1}</td>
            <td><div class="table-photo">${u.photo ? `<img src="/uploads/photos/${u.photo}" alt="${u.name}">` : `<div class="photo-placeholder-sm"><i class="fas fa-user"></i></div>`}</div></td>
            <td><div class="user-name">${u.name}</div><div class="user-id">${u.identifier}</div></td>
            <td>${u.position||'-'}</td>
            <td>${u.employment_status||'Guru'}</td>
            <td>Rp ${Number(u.basic_salary||0).toLocaleString('id-ID')}</td>
            <td>Rp ${Number(u.allowance||0).toLocaleString('id-ID')}</td>
            <td><button class="toggle-status badge badge-${u.status?'success':'secondary'}" data-id="${u._id}">${u.status?'Aktif':'Nonaktif'}</button></td>
            <td>${u.qr_code ? `<div class="qr-thumb"><img src="/uploads/qrcodes/${u.qr_code}" alt="QR"></div>` : '<span class="text-muted">-</span>'}</td>
            <td>
              <div class="action-group">
                <a href="/admin/users/detail/${u._id}" class="btn-action info" title="Detail"><i class="fas fa-eye"></i></a>
                <a href="/admin/users/edit/${u._id}" class="btn-action warning" title="Edit"><i class="fas fa-edit"></i></a>
                ${u.qr_code ? `<a href="/uploads/qrcodes/${u.qr_code}" download="QR_${u.identifier}.png" class="btn-action success" title="Download QR"><i class="fas fa-download"></i></a>` : ''}
                <button class="btn-action primary regen-qr" data-id="${u._id}" title="Regenerate QR"><i class="fas fa-qrcode"></i></button>
                <form method="POST" action="/admin/users/delete/${u._id}" style="display:inline" onsubmit="return confirm('Hapus pengguna ini?')">
                  <button type="submit" class="btn-action danger" title="Hapus"><i class="fas fa-trash"></i></button>
                </form>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="table-footer">${allUsers.length} pengguna ditemukan</div>
  </div>
</div>
</div>
<script src="/js/admin.js"></script>
<script>initUserPage();</script>
</body></html>`;
}

// ── User Form ────────────────────────────────────────
function renderUserFormPage(req, user) {
  const isEdit = !!user;
  const err = req.query.error ? `<div class="alert alert-danger"><i class="fas fa-exclamation-circle"></i> ${decodeURIComponent(req.query.error)}${String(req.query.error||'').includes('doGet') ? '<br><small style="display:block;margin-top:6px">Gunakan file GOOGLE_APPS_SCRIPT_IZIN.gs pada paket ini untuk memperbaiki endpoint Google Apps Script.</small>' : ''}</div>` : '';
  return `${baseHead(isEdit?'Edit Pengguna':'Tambah Pengguna')}
<body class="admin-body">
${adminSidebar(req,'users')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header">
    <div><h1 class="page-title">${isEdit?'Edit Pengguna':'Tambah Pengguna'}</h1></div>
    <a href="/admin/users" class="btn-outline"><i class="fas fa-arrow-left"></i> Kembali</a>
  </div>
  ${err}
  <div class="form-card">
    <form method="POST" action="${isEdit?`/admin/users/edit/${user._id}`:'/admin/users/add'}" enctype="multipart/form-data">
      <div class="form-grid-2">
        <div class="form-group"><label>Nama Lengkap <span class="required">*</span></label><input type="text" name="name" class="form-control" value="${user?.name||''}" required></div>
        <div class="form-group"><label>NIY <span class="required">*</span></label><input type="text" name="identifier" class="form-control" value="${user?.identifier||''}" required placeholder="Nomor Induk Yayasan"></div>
        <div class="form-group"><label>No. HP / WhatsApp</label><input type="text" name="phone" class="form-control" value="${user?.phone||''}" placeholder="08xxxxxxxxxx"></div>
        <div class="form-group"><label>Status Kepegawaian</label><select name="employment_status" class="form-control"><option value="Guru" ${(user?.employment_status||'Guru')==='Guru'?'selected':''}>Guru</option><option value="Karyawan" ${user?.employment_status==='Karyawan'?'selected':''}>Karyawan</option></select></div>
        <div class="form-group"><label>Gaji Pokok (Rp)</label><input type="number" min="0" name="basic_salary" class="form-control" value="${user?.basic_salary||0}"></div>
        <div class="form-group"><label>Tunjangan (Rp)</label><input type="number" min="0" name="allowance" class="form-control" value="${user?.allowance||0}"></div>
        <div class="form-group"><label>Username Login (data)</label><input type="text" name="login_username" class="form-control" value="${user?.login_username||''}"><small class="form-hint">Login guru/karyawan belum diaktifkan karena sistem hanya memiliki 1 aktor (Admin).</small></div>
        <div class="form-group"><label>Password Login (opsional)</label><input type="password" name="login_password" class="form-control" value=""><small class="form-hint">Disimpan terenkripsi bila diisi; tidak digunakan untuk login saat ini.</small></div>
        <div class="form-group"><label>Jabatan</label><input type="text" name="position" class="form-control" value="${user?.position||''}" placeholder="Kepala Sekolah / Guru / TU / Laboran"></div>
                <div class="form-group">
          <label>Foto Profil</label>
          ${user?.photo ? `<div class="current-photo"><img src="/uploads/photos/${user.photo}" alt="Foto"><span>Foto saat ini</span></div>` : ''}
          <input type="file" name="photo" class="form-control" accept="image/*">
          <small class="form-hint">JPG, PNG, WEBP. Maks. 5MB</small>
        </div>
      </div>
      <div class="form-actions">
        <a href="/admin/users" class="btn-outline">Batal</a>
        <button type="submit" class="btn-primary"><i class="fas fa-save"></i> ${isEdit?'Simpan Perubahan':'Tambah Pengguna'}</button>
      </div>
    </form>
  </div>
</div>
</div>
<script src="/js/admin.js"></script>
</body></html>`;
}

// ── User Detail ──────────────────────────────────────
function renderUserDetailPage(req, user, atts, totalHadir, totalTerlambat) {
  return `${baseHead('Detail Pengguna')}
<body class="admin-body">
${adminSidebar(req,'users')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header">
    <div><h1 class="page-title">Detail Pengguna</h1></div>
    <a href="/admin/users" class="btn-outline"><i class="fas fa-arrow-left"></i> Kembali</a>
  </div>
  <div class="detail-grid">
    <div class="detail-profile-card">
      <div class="profile-photo-wrap">${user.photo ? `<img src="/uploads/photos/${user.photo}" class="profile-photo">` : `<div class="profile-photo-placeholder"><i class="fas fa-user"></i></div>`}</div>
      <h2 class="profile-name">${user.name}</h2>
      <div class="profile-id">${user.identifier}</div>
      <span class="badge badge-${user.status?'success':'secondary'}">${user.status?'Aktif':'Nonaktif'}</span>
      <div class="profile-meta">
        <div class="meta-row"><i class="fas fa-briefcase"></i> ${user.position||'-'}</div>
        <div class="meta-row"><i class="fas fa-user-tag"></i> ${user.employment_status||'-'}</div>
        <div class="meta-row"><i class="fab fa-whatsapp"></i> ${user.phone||'-'}</div>
      </div>
      <div class="profile-stats">
        <div class="pstat"><div class="pstat-num success">${totalHadir}</div><div class="pstat-label">Hadir</div></div>
        <div class="pstat"><div class="pstat-num warning">${totalTerlambat}</div><div class="pstat-label">Terlambat</div></div>
      </div>
      ${user.qr_code ? `<div class="qr-section"><img src="/uploads/qrcodes/${user.qr_code}" class="detail-qr"><a href="/uploads/qrcodes/${user.qr_code}" download="QR_${user.identifier}.png" class="btn-primary mt-2"><i class="fas fa-download"></i> Download QR</a></div>` : ''}
    </div>
    <div class="detail-main">
      <div class="table-card">
        <div class="chart-header"><h3>Riwayat Presensi (20 Terakhir)</h3></div>
        <div class="table-responsive">
          <table class="data-table">
            <thead><tr><th>No</th><th>Tanggal</th><th>Jam Masuk</th><th>Jam Pulang</th><th>Status</th><th>Keterangan</th></tr></thead>
            <tbody>
              ${atts.length===0 ? '<tr><td colspan="6" class="empty-cell">Belum ada presensi.</td></tr>' : atts.map((a,i)=>`
              <tr>
                <td>${i+1}</td><td>${a.attendance_date}</td>
                <td><strong>${(a.attendance_time||'').substring(0,5)}</strong> WIB</td>
                <td><strong>${a.attendance_out_time ? a.attendance_out_time.substring(0,5) : '-'}</strong>${a.attendance_out_time ? ' WIB' : ''}</td>
                <td><span class="badge badge-${a.status==='Hadir'?'success':a.status==='Terlambat'?'warning':'info'}">${a.status}</span></td>
                <td>${a.notes||'-'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
<script src="/js/admin.js"></script>
</body></html>`;
}

// ── Attendance Page ──────────────────────────────────
function renderAttendancePage(req, records, filters) {
  const msg = req.query.success ? `<div class="alert alert-success"><i class="fas fa-check-circle"></i> ${decodeURIComponent(req.query.success)}</div>` : '';
  return `${baseHead('Data Presensi')}
<body class="admin-body">
${adminSidebar(req,'attendance')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header">
    <div><h1 class="page-title">Data Presensi</h1><p class="page-sub">Rekap seluruh data kehadiran</p></div>
    <button class="btn-primary" onclick="document.getElementById('exportModal').classList.add('show')"><i class="fas fa-file-excel"></i> Export Excel</button>
  </div>
  ${msg}
  <div class="table-card">
    <div class="table-toolbar flex-wrap">
      <form method="GET" class="filter-form">
        <input type="text" name="search" value="${filters.search||''}" placeholder="Cari nama / NIY..." class="search-input">
        <input type="date" name="date" value="${filters.date||''}" class="form-control-sm">
        <input type="month" name="month" value="${filters.month||''}" class="form-control-sm">
        <select name="status" class="form-control-sm">
          <option value="">Semua Status</option>
          ${['Hadir','Terlambat','Izin','Sakit'].map(s=>`<option value="${s}" ${filters.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
        <button type="submit" class="btn-search"><i class="fas fa-filter"></i> Filter</button>
        <a href="/admin/attendance" class="btn-clear">Reset</a>
      </form>
    </div>
    <div class="table-responsive">
      <table class="data-table">
        <thead><tr><th>No</th><th>Foto</th><th>Nama</th><th>NIY</th><th>Jabatan</th><th>Tanggal</th><th>Jam Masuk</th><th>Jam Pulang</th><th>Status</th><th>Aksi</th></tr></thead>
        <tbody>
          ${records.length===0 ? '<tr><td colspan="10" class="empty-cell">Tidak ada data presensi.</td></tr>' : records.map((r,i)=>`
          <tr>
            <td>${i+1}</td>
            <td><div class="table-photo">${r.photo?`<img src="/uploads/photos/${r.photo}" alt="${r.name}">`:`<div class="photo-placeholder-sm"><i class="fas fa-user"></i></div>`}</div></td>
            <td><div class="user-name">${r.name}</div><small>${r.position||''}</small></td>
            <td>${r.identifier}</td>
            <td>${r.position||'-'}</td>
            <td>${r.attendance_date}</td>
            <td><strong>${(r.attendance_time||'').substring(0,5)}</strong> WIB</td>
            <td><strong>${r.attendance_out_time ? r.attendance_out_time.substring(0,5) : '-'}</strong>${r.attendance_out_time ? ' WIB' : ''}</td>
            <td><span class="badge badge-${r.status==='Hadir'?'success':r.status==='Terlambat'?'warning':'info'}">${r.status}</span></td>
            <td><form method="POST" action="/admin/attendance/delete/${r._id}" style="display:inline" onsubmit="return confirm('Hapus data ini?')"><button type="submit" class="btn-action danger"><i class="fas fa-trash"></i></button></form></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="table-footer">${records.length} data ditemukan</div>
  </div>
</div>
</div>
<!-- Export Modal -->
<div class="modal-overlay" id="exportModal">
  <div class="modal-box">
    <div class="modal-header"><h3><i class="fas fa-file-excel"></i> Export Data Presensi</h3><button onclick="document.getElementById('exportModal').classList.remove('show')" class="modal-close"><i class="fas fa-times"></i></button></div>
    <form action="/admin/attendance/export" method="GET" class="modal-body">
      <div class="form-group">
        <label>Jenis Export</label>
        <select name="type" class="form-control" id="exportType" onchange="showExportFields()">
          <option value="today">Hari Ini</option>
          <option value="date">Tanggal Tertentu</option>
          <option value="month">Bulan Tertentu</option>
          <option value="range">Rentang Tanggal</option>
                    <option value="all">Semua Data (Bulan Ini)</option>
        </select>
      </div>
      <div id="fieldDate" class="form-group" style="display:none"><label>Pilih Tanggal</label><input type="date" name="date" class="form-control"></div>
      <div id="fieldMonth" class="form-group" style="display:none"><label>Pilih Bulan</label><input type="month" name="month" class="form-control"></div>
      <div id="fieldRange" style="display:none">
        <div class="form-grid-2">
          <div class="form-group"><label>Dari Tanggal</label><input type="date" name="start_date" class="form-control"></div>
          <div class="form-group"><label>Sampai Tanggal</label><input type="date" name="end_date" class="form-control"></div>
        </div>
      </div>
      
      <div class="modal-footer">
        <button type="button" onclick="document.getElementById('exportModal').classList.remove('show')" class="btn-outline">Batal</button>
        <button type="submit" class="btn-primary"><i class="fas fa-download"></i> Download Excel</button>
      </div>
    </form>
  </div>
</div>
<script src="/js/admin.js"></script>
<script>
function showExportFields(){
  const t = document.getElementById('exportType').value;
  ['Date','Month','Range','Division'].forEach(f => document.getElementById('field'+f).style.display='none');
  if(t==='date') document.getElementById('fieldDate').style.display='block';
  else if(t==='month') document.getElementById('fieldMonth').style.display='block';
  else if(t==='range') document.getElementById('fieldRange').style.display='block';
  else if(t==='division') document.getElementById('fieldDivision').style.display='block';
}
</script>
</body></html>`;
}

// ── Leave / Izin Page ─────────────────────────────────────
function renderLeavePage(req, rows, formUrl) {
  const msg = req.query.success ? `<div class="alert alert-success"><i class="fas fa-check-circle"></i> ${decodeURIComponent(req.query.success)}</div>` : '';
  const rawErr = req.query.error ? decodeURIComponent(req.query.error) : '';
  const isAccessErr = /meminta izin\/login|permission|access denied|not authorized|bukan JSON/i.test(rawErr);
  const err = rawErr ? `<div class="alert alert-danger"><i class="fas fa-exclamation-circle"></i> ${rawErr}${isAccessErr ? '<br><small style="display:block;margin-top:6px">Google Apps Script pada akun Google Workspace dapat meminta login sehingga server lokal tidak bisa mengambil JSON secara otomatis. Gunakan tombol <strong>Input Izin Manual</strong> sementara, atau ubah sumber menjadi endpoint yang dapat diakses server.</small>' : ''}</div>` : '';
  const pending = rows.filter(r=>r.status==='Menunggu').length;
  const approved = rows.filter(r=>r.status==='Disetujui').length;
  const rejected = rows.filter(r=>r.status==='Ditolak').length;
  const statusBadge = status => status==='Disetujui'?'success':status==='Ditolak'?'danger':'warning';
  const safe = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `${baseHead('Pengajuan Izin')}
<body class="admin-body">
${adminSidebar(req,'leave')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header">
    <div><h1 class="page-title">Pengajuan Izin</h1><p class="page-sub">Validasi, persetujuan, penolakan, dan notifikasi izin Guru/Karyawan</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <form method="POST" action="/admin/leave/sync"><button class="btn-primary" type="submit"><i class="fas fa-rotate"></i> Sinkron Google Form</button></form>
      <button class="btn-outline" type="button" onclick="document.getElementById('manualLeaveModal').classList.add('show')"><i class="fas fa-plus"></i> Input Izin Manual</button>
      <a class="btn-outline" href="${awaitableEscapeLink(formUrl)}" target="_blank"><i class="fas fa-external-link-alt"></i> Buka Form Izin</a>
    </div>
  </div>
  ${msg}${err}
  <div class="stats-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
    <div class="stat-card warning"><div class="stat-icon"><i class="fas fa-hourglass-half"></i></div><div class="stat-body"><div class="stat-number">${pending}</div><div class="stat-label">Menunggu Validasi</div></div></div>
    <div class="stat-card success"><div class="stat-icon"><i class="fas fa-check"></i></div><div class="stat-body"><div class="stat-number">${approved}</div><div class="stat-label">Disetujui</div></div></div>
    <div class="stat-card danger"><div class="stat-icon"><i class="fas fa-xmark"></i></div><div class="stat-body"><div class="stat-number">${rejected}</div><div class="stat-label">Ditolak</div></div></div>
  </div>
  <div class="alert alert-info"><i class="fas fa-circle-info"></i> <strong>Alur:</strong> Guru/Karyawan mengisi Google Form → data masuk sebagai pengajuan → Admin memeriksa → <strong>Setujui/Tolak</strong> → Admin mengirim hasil melalui WhatsApp. Karena akses Google Apps Script pada akun tertentu bisa memerlukan login, tersedia <strong>Input Izin Manual</strong> sebagai jalur cadangan.</div>
  <div class="table-card">
    <div class="table-toolbar"><strong>Daftar Pengajuan</strong><span style="margin-left:auto;color:var(--text-muted);font-size:.85rem">Total ${rows.length} pengajuan</span></div>
    <div class="table-responsive"><table class="data-table"><thead><tr><th>No</th><th>Nama / NIY</th><th>Jenis</th><th>Tanggal</th><th>Alasan</th><th>Sumber</th><th>Status</th><th style="min-width:230px">Aksi</th></tr></thead><tbody>
    ${rows.length===0 ? '<tr><td colspan="8"><div class="empty-msg"><i class="fas fa-inbox"></i><span>Belum ada pengajuan izin.</span><small style="display:block;margin-top:6px">Klik “Input Izin Manual” atau sinkronkan dari Google Form.</small></div></td></tr>' : rows.map((r,i)=>`<tr>
      <td>${i+1}</td>
      <td><strong>${safe(r.name)}</strong><br><small>NIY: ${safe(r.identifier||'-')}</small>${r.phone?`<br><small>WA: ${safe(r.phone)}</small>`:''}</td>
      <td>${safe(r.leave_type||'-')}</td>
      <td>${safe(fmtDate(r.start_date))}${r.end_date && r.end_date!==r.start_date?`<br><small>s/d ${safe(fmtDate(r.end_date))}</small>`:''}</td>
      <td style="max-width:260px;white-space:normal">${safe(r.reason||'-')}</td>
      <td><span class="badge badge-info">${safe(r.source||'Google Form')}</span><br><small>${safe(fmtDate(r.submitted_at))}</small></td>
      <td><span class="badge badge-${statusBadge(r.status)}">${safe(r.status||'Menunggu')}</span>${r.admin_note?`<br><small><strong>Catatan:</strong> ${safe(r.admin_note)}</small>`:''}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${r.status==='Menunggu' ? `<form method="POST" action="/admin/leave/${r._id}/status" style="display:flex;gap:4px"><input type="hidden" name="status" value="Disetujui"><input type="text" name="admin_note" class="form-control-sm" placeholder="Catatan (opsional)" style="width:145px"><button class="btn-action success" title="Setujui"><i class="fas fa-check"></i></button></form><form method="POST" action="/admin/leave/${r._id}/status" style="display:flex;gap:4px"><input type="hidden" name="status" value="Ditolak"><input type="text" name="admin_note" class="form-control-sm" placeholder="Alasan penolakan" style="width:145px"><button class="btn-action danger" title="Tolak"><i class="fas fa-xmark"></i></button></form>`:''}
        <a class="btn-action info" href="/admin/leave/${r._id}/whatsapp" title="Kirim hasil via WhatsApp"><i class="fab fa-whatsapp"></i></a>
        </div>
      </td>
    </tr>`).join('')}
    </tbody></table></div>
  </div>
</div></div>
<div id="manualLeaveModal" class="modal-overlay" onclick="if(event.target===this)this.classList.remove('show')">
  <div class="modal-box" style="max-width:760px">
    <div class="modal-header"><h3><i class="fas fa-file-circle-plus"></i> Input Pengajuan Izin Manual</h3><button type="button" class="modal-close" onclick="document.getElementById('manualLeaveModal').classList.remove('show')">&times;</button></div>
    <form method="POST" action="/admin/leave/manual">
      <div class="modal-body">
        <div class="form-grid-2">
          <div class="form-group"><label>Nama Lengkap *</label><input name="name" class="form-control" required></div>
          <div class="form-group"><label>NIY</label><input name="identifier" class="form-control" placeholder="NIY Guru/Karyawan"></div>
          <div class="form-group"><label>No. HP / WhatsApp</label><input name="phone" class="form-control" placeholder="08xxxxxxxxxx"></div>
          <div class="form-group"><label>Jenis Izin</label><select name="leave_type" class="form-control"><option>Izin</option><option>Sakit</option><option>Dinas</option><option>Keperluan Keluarga</option><option>Lainnya</option></select></div>
          <div class="form-group"><label>Tanggal Mulai *</label><input type="date" name="start_date" class="form-control" required></div>
          <div class="form-group"><label>Tanggal Selesai</label><input type="date" name="end_date" class="form-control"></div>
        </div>
        <div class="form-group"><label>Alasan *</label><textarea name="reason" class="form-control" rows="4" required placeholder="Tulis alasan izin..."></textarea></div>
      </div>
      <div class="modal-footer"><button type="button" class="btn-outline" onclick="document.getElementById('manualLeaveModal').classList.remove('show')">Batal</button><button class="btn-primary" type="submit"><i class="fas fa-save"></i> Simpan Pengajuan</button></div>
    </form>
  </div>
</div>
<script src="/js/admin.js"></script></body></html>`;
}

function awaitableEscapeLink(value) {
  return String(value||'#').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Settings Page ─────────────────────────────────────
function renderSettingsPage(req, s) {
  const msg = req.query.success ? `<div class="alert alert-success"><i class="fas fa-check-circle"></i> ${decodeURIComponent(req.query.success)}</div>` : '';
  return `${baseHead('Pengaturan')}
<body class="admin-body">
${adminSidebar(req,'settings')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header"><h1 class="page-title">Pengaturan</h1><p class="page-sub">Konfigurasi sistem presensi</p></div>
  ${msg}
  <div class="form-card">
    <form method="POST" action="/admin/settings">
      <h3 class="section-title"><i class="fas fa-building"></i> Informasi Institusi</h3>
      <div class="form-group"><label>Nama Institusi</label><input type="text" name="institution_name" class="form-control" value="${s.institution_name||''}"></div>
      <h3 class="section-title mt-4"><i class="fas fa-clock"></i> Batas Waktu Presensi</h3>
      <div class="form-grid-2">
        <div class="form-group"><label>Jam Kerja Masuk Resmi</label><input type="time" name="work_start" class="form-control" value="${s.work_start||'07:30'}"></div>
        <div class="form-group"><label>Jam Kerja Pulang Resmi</label><input type="time" name="work_end" class="form-control" value="${s.work_end||'16:00'}"></div>
        <div class="form-group"><label>Batas Hadir / Tepat Waktu</label><input type="time" name="ontime_limit" class="form-control" value="${s.ontime_limit||'08:00'}"></div>
        <div class="form-group"><label>Batas Terlambat</label><input type="time" name="late_limit" class="form-control" value="${s.late_limit||'09:00'}"></div>
        <div class="form-group"><label>Toleransi Keterlambatan (menit)</label><input type="number" min="0" name="late_tolerance_minutes" class="form-control" value="${s.late_tolerance_minutes||'15'}"></div>
        <div class="form-group"><label>Pulang Lebih Awal Dihitung?</label><select name="early_leave_counted" class="form-control"><option value="1" ${(s.early_leave_counted||'1')==='1'?'selected':''}>Ya</option><option value="0" ${s.early_leave_counted==='0'?'selected':''}>Tidak</option></select></div>
      </div>
      <div class="form-grid-2 mt-4">
        <div class="form-group"><label>Potongan Terlambat / Menit (Rp)</label><input type="number" min="0" name="late_deduction_per_minute" class="form-control" value="${s.late_deduction_per_minute||'1000'}"></div>
        <div class="form-group"><label>Potongan Pulang Awal / Menit (Rp)</label><input type="number" min="0" name="early_leave_deduction_per_minute" class="form-control" value="${s.early_leave_deduction_per_minute||'1000'}"></div>
      </div>
      <h3 class="section-title mt-4"><i class="fas fa-money-bill-wave"></i> Aturan Gaji</h3>
      <div class="form-group"><label>Periode Gaji</label><select name="payroll_period" class="form-control"><option value="1-end" ${(s.payroll_period||'1-end')==='1-end'?'selected':''}>Tanggal 1 sampai akhir bulan</option><option value="26-25" ${s.payroll_period==='26-25'?'selected':''}>Tanggal 26 sampai 25</option></select><small class="form-hint">Default 1–akhir bulan agar rekap keterlambatan mengikuti bulan kalender.</small></div>
      <div class="form-grid-2">
        <div class="form-group"><label>Tempat Tanda Tangan Slip Gaji</label><input type="text" name="payroll_place" class="form-control" value="${s.payroll_place||'Seyegan'}" placeholder="Seyegan"></div>
        <div class="form-group"><label>Nama Bendahara Sekolah</label><input type="text" name="payroll_treasurer_name" class="form-control" value="${s.payroll_treasurer_name||'Dra. Agnes Sukarnihari'}" placeholder="Dra. Agnes Sukarnihari"></div>
      </div>
      <div class="alert alert-info"><i class="fas fa-file-signature"></i> Kolom tanda tangan pada slip PDF akan menampilkan tempat, tanggal, jabatan Bendahara Sekolah, area tanda tangan, dan nama bendahara.</div>
      <div class="form-grid-2">
        <div class="form-group"><label>Google Form Izin</label><input type="url" name="izin_form_url" class="form-control" value="${s.izin_form_url||''}"></div>
        <div class="form-group"><label>Google Apps Script Izin</label><input type="url" name="izin_script_url" class="form-control" value="${s.izin_script_url||''}"></div>
        <div class="form-group"><label>Nomor WhatsApp Notifikasi Izin</label><input type="text" name="izin_wa_number" class="form-control" value="${s.izin_wa_number||'08xxxxxxxxxx'}" placeholder="08xxxxxxxxxx"><small class="form-hint">Setelah admin menyetujui/menolak, tombol Kirim WA akan membuka pesan ke nomor ini.</small></div>
      </div>
      <div class="alert alert-info mt-4"><i class="fas fa-circle-info"></i> Sistem menggunakan 1 aktor, yaitu Administrator. Guru/karyawan tidak mengisi potongan gaji sendiri. Potongan manual hanya dimasukkan Admin.</div>
      <h3 class="section-title mt-4"><i class="fas fa-globe"></i> Zona Waktu</h3>
      <div class="form-group">
        <label>Zona Waktu</label>
        <select name="timezone" class="form-control">
          <option value="Asia/Jakarta" ${(s.timezone||'Asia/Jakarta')==='Asia/Jakarta'?'selected':''}>WIB (UTC+7) — Jawa, Sumatera, Kalimantan Barat</option>
          <option value="Asia/Makassar" ${s.timezone==='Asia/Makassar'?'selected':''}>WITA (UTC+8) — Bali, NTT, Kalimantan Selatan</option>
          <option value="Asia/Jayapura" ${s.timezone==='Asia/Jayapura'?'selected':''}>WIT (UTC+9) — Papua, Maluku</option>
        </select>
      </div>
      <div class="form-actions"><button type="submit" class="btn-primary"><i class="fas fa-save"></i> Simpan Pengaturan</button></div>
    </form>
  </div>
</div>
</div>
<script src="/js/admin.js"></script>
</body></html>`;
}


// ── QR Page ──────────────────────────────────────────
function renderQRPage(req, allUsers) {
  return `${baseHead('QR Code')}
<body class="admin-body">
${adminSidebar(req,'qrcodes')}
<div class="admin-main">
${adminTopbar(req)}
<div class="admin-content">
  <div class="page-header"><h1 class="page-title">Manajemen QR Code</h1><p class="page-sub">QR Code seluruh pengguna aktif</p></div>
  <div class="qr-grid">
    ${allUsers.map(u => `
    <div class="qr-card">
      <div class="qr-card-photo">${u.photo?`<img src="/uploads/photos/${u.photo}" alt="${u.name}">`:`<div class="photo-placeholder"><i class="fas fa-user"></i></div>`}</div>
      <div class="qr-card-name">${u.name}</div>
      <div class="qr-card-id">${u.identifier}</div>
      <div class="qr-card-div">${u.division||''} · ${u.class||''}</div>
      <div class="qr-card-img" id="qrWrap${u._id}">
        ${u.qr_code ? `<img src="/uploads/qrcodes/${u.qr_code}" id="qrImg${u._id}" alt="QR">` : `<div class="qr-placeholder"><i class="fas fa-qrcode"></i><span>Belum ada QR</span></div>`}
      </div>
      <div class="qr-card-actions">
        ${u.qr_code ? `<a href="/uploads/qrcodes/${u.qr_code}" download="QR_${u.identifier}.png" class="btn-sm success"><i class="fas fa-download"></i> Download</a>` : ''}
        <button class="btn-sm primary regen-qr" data-id="${u._id}"><i class="fas fa-sync"></i> ${u.qr_code?'Regenerate':'Generate'}</button>
      </div>
    </div>`).join('')}
  </div>
</div>
</div>
<script src="/js/admin.js"></script>
<script>initUserPage();</script>
</body></html>`;
}

// ── Start ─────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT || (PORT + 1));
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_KEY = path.join(CERT_DIR, 'server-key.pem');
const CERT_FILE = path.join(CERT_DIR, 'server-cert.pem');
const HTTPS_ENABLED = process.env.HTTPS === '1' && fs.existsSync(CERT_KEY) && fs.existsSync(CERT_FILE);

function getLanIp() {
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

ready.then(() => {
  const lanIp = getLanIp();

  if (HTTPS_ENABLED) {
    const tlsOptions = {
      key: fs.readFileSync(CERT_KEY),
      cert: fs.readFileSync(CERT_FILE)
    };

    https.createServer(tlsOptions, app).listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('╔════════════════════════════════════════════════════╗');
      console.log('║        ✅ PresensiQR HTTPS Server Ready!          ║');
      console.log('╠════════════════════════════════════════════════════╣');
      console.log(`║  Scan (laptop) : https://localhost:${PORT}/scan`);
      console.log(`║  Scan (LAN)    : https://${lanIp}:${PORT}/scan`);
      console.log(`║  Admin (LAN)   : https://${lanIp}:${PORT}/admin/login`);
      console.log(`║  HTTP redirect : http://${lanIp}:${HTTP_REDIRECT_PORT}/scan`);
      console.log('║  Login         : admin@presensi.ac.id             ║');
      console.log('║  Password      : admin123                          ║');
      console.log('╚════════════════════════════════════════════════════╝');
      console.log('');
      console.log('🔐 HTTPS aktif. Kamera browser siap digunakan setelah');
      console.log('   perangkat mempercayai sertifikat lokal (mkcert).');
      console.log('');

      http.createServer((req, res) => {
        const host = (req.headers.host || '').split(':')[0] || lanIp;
        const target = `https://${host}:${PORT}${req.url || '/'}`;
        res.writeHead(301, { Location: target });
        res.end();
      }).listen(HTTP_REDIRECT_PORT, '0.0.0.0');
    });
  } else {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('╔════════════════════════════════════════════════════╗');
      console.log('║          ✅ PresensiQR System Ready!              ║');
      console.log('╠════════════════════════════════════════════════════╣');
      console.log(`║  Local         : http://localhost:${PORT}/scan`);
      console.log(`║  LAN           : http://${lanIp}:${PORT}/scan`);
      console.log(`║  Admin (LAN)   : http://${lanIp}:${PORT}/admin/login`);
      console.log('║  Login         : admin@presensi.ac.id             ║');
      console.log('║  Password      : admin123                          ║');
      console.log('╚════════════════════════════════════════════════════╝');
      console.log('');
      console.log('⚠️  HTTPS belum aktif. Jalankan START_HTTPS.bat');
      console.log('   agar kamera dapat digunakan dari HP/LAN.');
      console.log('');
    });
  }
});
