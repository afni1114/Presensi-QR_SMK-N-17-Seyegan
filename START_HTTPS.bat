@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ================================================
echo   PresensiQR - HTTPS Setup & Start
echo ================================================
echo.

where mkcert >nul 2>&1
if errorlevel 1 (
  echo [ERROR] mkcert belum terinstall.
  echo.
  echo Install mkcert terlebih dahulu melalui PowerShell Administrator:
  echo     winget install FiloSottile.mkcert
  echo.
  echo Setelah selesai, jalankan START_HTTPS.bat lagi.
  pause
  exit /b 1
)

if not exist certs mkdir certs

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$ip=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } | Select-Object -First 1 -ExpandProperty IPAddress; if ($ip) { $ip }"`) do set "LAN_IP=%%I"

if not defined LAN_IP (
  echo [ERROR] IP LAN tidak ditemukan.
  echo Pastikan Wi-Fi/LAN aktif.
  pause
  exit /b 1
)

echo [INFO] IP LAN terdeteksi: %LAN_IP%
echo [INFO] Menyiapkan Local CA...
mkcert -install
if errorlevel 1 (
  echo [ERROR] mkcert -install gagal.
  pause
  exit /b 1
)

echo [INFO] Membuat sertifikat HTTPS...
mkcert -cert-file certs/server-cert.pem -key-file certs/server-key.pem %LAN_IP% localhost 127.0.0.1 ::1
if errorlevel 1 (
  echo [ERROR] Pembuatan sertifikat gagal.
  pause
  exit /b 1
)

set "HTTPS=1"
set "PORT=3000"

echo.
echo ================================================
echo   HTTPS aktif
 echo   https://localhost:3000/scan
 echo   https://%LAN_IP%:3000/scan
 echo.
echo   Untuk HP/laptop lain, install rootCA.pem
 echo   dari folder yang ditampilkan oleh:
 echo       mkcert -CAROOT
 echo ================================================
echo.
node app.js
pause
