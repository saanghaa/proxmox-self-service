#!/usr/bin/env bash
set -euo pipefail

# Reset a user's OTP (TOTP) configuration.
# Intended as a break-glass admin operation when SMTP/email recovery isn't available.
#
# Usage:
#   ./scripts/otp-reset.sh user@example.com
#
# What it does:
# - sets User.totpSecret = NULL
# - sets User.totpEnabled = false
# - deletes all OtpRecoveryCode rows for the user
# - writes an AuditLog entry (action=OTP_RESET_CLI)

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0 <email>"
  exit 1
fi

EMAIL="$1"

cd "$(dirname "$0")/.."

echo "[OTP Reset] Target email: ${EMAIL}"
echo "[OTP Reset] This will disable OTP for the user and remove all recovery codes."
read -r -p "Proceed? (y/N): " confirm
confirm="${confirm:-N}"
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "[OTP Reset] Aborted."
  exit 0
fi

docker compose exec -T app node -e "
const email = process.argv[1];
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const u = await prisma.user.findUnique({ where: { email }, select: { id:true, email:true, isAdmin:true, totpEnabled:true }});
  if (!u) {
    console.error('[OTP Reset] User not found:', email);
    process.exit(2);
  }

  await prisma.\$transaction([
    prisma.otpRecoveryCode.deleteMany({ where: { userId: u.id } }),
    prisma.user.update({ where: { id: u.id }, data: { totpSecret: null, totpEnabled: false } }),
    prisma.auditLog.create({
      data: {
        userId: u.id,
        action: 'OTP_RESET_CLI',
        result: 'SUCCESS',
        reason: 'CLI break-glass OTP reset',
        requestIp: 'CLI',
        userAgent: 'otp-reset.sh'
      }
    })
  ]);

  console.log('[OTP Reset] Done:', { email: u.email, wasAdmin: u.isAdmin, wasEnabled: u.totpEnabled });
})().catch(async (e) => {
  try {
    await prisma.auditLog.create({
      data: {
        action: 'OTP_RESET_CLI',
        result: 'FAIL',
        reason: String(e && e.message ? e.message : e),
        requestIp: 'CLI',
        userAgent: 'otp-reset.sh'
      }
    });
  } catch (_) {}
  console.error('[OTP Reset] Failed:', e && e.stack ? e.stack : e);
  process.exit(1);
}).finally(async () => {
  await prisma.\$disconnect();
});
" "$EMAIL"

echo "[OTP Reset] Completed."

