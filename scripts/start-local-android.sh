#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js نصب نیست. در Termux اجرا کنید: pkg install nodejs-lts"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm پیدا نشد؛ نصب Node.js در Termux را بررسی کنید."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "در حال نصب وابستگی‌های هلو..."
  npm install
fi

echo "در حال ساخت نسخه وب..."
npm run build

echo "سرور هلو روی پورت 3000 اجرا می‌شود."
echo "در همان گوشی مرورگر را باز کنید: http://127.0.0.1:3000"
echo "برای توقف سرور، Ctrl+C را بزنید."
export PORT="${PORT:-3000}"
exec npx tsx server.ts
