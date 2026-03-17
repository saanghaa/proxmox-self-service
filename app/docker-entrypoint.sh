#!/bin/sh
set -e

echo "[Init] Starting Proxmox Horizon initialization..."

echo "[Init] PostgreSQL is ready (checked by Docker Healthcheck)"

echo "[Init] Running database migrations..."
npx prisma migrate deploy || {
  echo "[Warn] No migrations found or migration failed"
  echo "[Init] Pushing schema to database..."
  npx prisma db push --skip-generate --accept-data-loss
}

# In fresh environments, migrate deploy can succeed with "no migrations"
# while tables are still absent. Verify core table existence and push schema if needed.
SCHEMA_READY=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    // Verify core tables exist. If any are missing, db push will reconcile schema.
    await p.user.count();
    // Newer features rely on this table existing as well.
    await p.otpRecoveryCode.count();
    console.log('1');
  } catch (e) {
    console.log('0');
  } finally {
    await p.\$disconnect();
  }
})();
" 2>/dev/null)

if [ "$SCHEMA_READY" != "1" ]; then
  echo "[Init] Schema tables not found. Running prisma db push..."
  npx prisma db push --skip-generate --accept-data-loss
fi

# Resolve default file path.
# Priority:
# 1) /config (only when USE_CONFIG_DEFAULTS=true)
# 2) /app/dist/defaults (source-coupled defaults)
# 3) /config (fallback)
resolve_default_path() {
  name="$1"
  from_image="/app/dist/defaults/$name"
  from_config="/config/$name"

  if [ "${USE_CONFIG_DEFAULTS:-false}" = "true" ] && [ -f "$from_config" ]; then
    echo "$from_config"
    return
  fi

  if [ -f "$from_image" ]; then
    echo "$from_image"
    return
  fi

  if [ -f "$from_config" ]; then
    echo "$from_config"
    return
  fi

  echo ""
}

echo "[Init] Checking if database needs seeding..."
USER_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.count().then(c => { console.log(c); return p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null)

if [ "$USER_COUNT" = "0" ] || [ "$USER_COUNT" = "" ]; then
  echo "[Init] Seeding database..."
  npx tsx prisma/seed.ts || echo "[Warn] Seed failed or already completed"
else
  echo "[Init] Database already seeded (found $USER_COUNT users)"
fi

echo "[Init] Checking bootstrap admin configuration..."
ADMIN_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.count({ where: { isAdmin: true } }).then(c => { console.log(c); return p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null)

BOOTSTRAP_ADMIN_EMAIL=$(printf '%s' "${INITIAL_ADMIN_EMAIL:-}" | tr '[:upper:]' '[:lower:]' | tr -d '\r\n' | xargs)
BOOTSTRAP_ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-}"

if [ "$ADMIN_COUNT" = "0" ] || [ "$ADMIN_COUNT" = "" ]; then
  if [ -n "$BOOTSTRAP_ADMIN_EMAIL" ] && [ -n "$BOOTSTRAP_ADMIN_PASSWORD" ]; then
    echo "[Init] Creating bootstrap admin from install options..."
    INITIAL_ADMIN_EMAIL="$BOOTSTRAP_ADMIN_EMAIL" INITIAL_ADMIN_PASSWORD="$BOOTSTRAP_ADMIN_PASSWORD" node -e "
    const bcrypt = require('bcryptjs');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    (async () => {
      try {
        const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
        const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');

        if (!email) throw new Error('INITIAL_ADMIN_EMAIL is empty');
        if (password.length < 8) throw new Error('INITIAL_ADMIN_PASSWORD must be at least 8 characters');

        const existingAdminCount = await prisma.user.count({ where: { isAdmin: true } });
        if (existingAdminCount > 0) {
          console.log('[Init] Bootstrap admin skipped: admin already exists');
          return;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const adminUser = await prisma.user.create({
          data: {
            email,
            passwordHash,
            passwordLastChanged: new Date(),
            isActive: true,
            isAdmin: true,
            totpEnabled: false,
            mustChangePassword: false,
          }
        });

        const adminGroup = await prisma.group.upsert({
          where: { name: 'ADMIN' },
          update: {},
          create: { name: 'ADMIN' },
        });

        await prisma.groupMembership.upsert({
          where: { userId_groupId: { userId: adminUser.id, groupId: adminGroup.id } },
          update: { role: 'admin' },
          create: { userId: adminUser.id, groupId: adminGroup.id, role: 'admin' },
        });

        console.log('[Init] Bootstrap admin created for ' + email);
      } catch (e) {
        console.error('[Init] Bootstrap admin creation failed:', e.message);
        process.exit(1);
      } finally {
        await prisma.\$disconnect();
      }
    })();
    "
  else
    echo "[Init] No bootstrap admin credentials provided. Web /setup remains enabled."
  fi
else
  echo "[Init] Admin account already exists; skipping bootstrap admin creation."
fi

echo "[Init] Checking menu configuration..."
MENU_CONFIG_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.systemConfig.count({ where: { key: 'menu_config' } }).then(c => { console.log(c); return p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null)

MENU_DEFAULT_PATH=$(resolve_default_path "default-menu-config.json")

if [ "$MENU_CONFIG_COUNT" = "0" ] || [ "$MENU_CONFIG_COUNT" = "" ]; then
  echo "[Init] Initializing default menu configuration..."
  if [ -n "$MENU_DEFAULT_PATH" ] && [ -f "$MENU_DEFAULT_PATH" ]; then
    echo "[Init] Loading from $MENU_DEFAULT_PATH"
    node -e "
    const fs = require('fs');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    (async () => {
      try {
        const configJson = fs.readFileSync('${MENU_DEFAULT_PATH}', 'utf8');
        await prisma.systemConfig.create({
          data: {
            key: 'menu_config',
            value: configJson
          }
        });
        console.log('[Init] Menu configuration initialized');
      } catch (e) {
        console.log('[Warn] Menu initialization skipped:', e.message);
      } finally {
        await prisma.\$disconnect();
      }
    })();
    " || echo "[Warn] Failed to load menu config"
  else
    echo "[Warn] No default-menu-config.json found"
  fi
else
  echo "[Init] Menu configuration already exists (DB is source of truth)"
  if [ "${MENU_CONFIG_MERGE_DEFAULTS:-false}" = "true" ] && [ -n "$MENU_DEFAULT_PATH" ] && [ -f "$MENU_DEFAULT_PATH" ]; then
    echo "[Init] Checking for new menu items to merge (MENU_CONFIG_MERGE_DEFAULTS=true)..."
    node -e "
    const fs = require('fs');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    (async () => {
      try {
        const defaultConfig = JSON.parse(fs.readFileSync('${MENU_DEFAULT_PATH}', 'utf8'));
        const row = await prisma.systemConfig.findUnique({ where: { key: 'menu_config' } });
        if (!row) return;
        const dbConfig = JSON.parse(row.value);
        let changed = false;

        for (const section of ['header_menus', 'admin_tabs', 'sidebar_menus']) {
          if (!defaultConfig[section]) continue;
          if (!dbConfig[section]) dbConfig[section] = [];
          const existingKeys = new Set(dbConfig[section].map(m => m.menu_key));
          for (const item of defaultConfig[section]) {
            if (!existingKeys.has(item.menu_key)) {
              dbConfig[section].push(item);
              console.log('[Init] Added new menu item:', item.menu_key, '(' + section + ')');
              changed = true;
            }
          }
        }

        if (changed) {
          await prisma.systemConfig.update({
            where: { key: 'menu_config' },
            data: { value: JSON.stringify(dbConfig) }
          });
          console.log('[Init] New menu items merged into DB');
        } else {
          console.log('[Init] No new menu items to add');
        }
      } catch (e) {
        console.log('[Warn] Menu merge skipped:', e.message);
      } finally {
        await prisma.\$disconnect();
      }
    })();
    " || echo "[Warn] Menu merge check failed"
  else
    echo "[Init] Skipping default menu merge (set MENU_CONFIG_MERGE_DEFAULTS=true to enable)"
  fi
fi

echo "[Init] Checking section labels..."
SECTION_LABELS_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.systemConfig.count({ where: { key: 'section_labels' } }).then(c => { console.log(c); return p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null)

SECTION_LABELS_DEFAULT_PATH=$(resolve_default_path "default-section-labels.json")

if [ "$SECTION_LABELS_COUNT" = "0" ] || [ "$SECTION_LABELS_COUNT" = "" ]; then
  echo "[Init] Initializing default section labels..."
  if [ -n "$SECTION_LABELS_DEFAULT_PATH" ] && [ -f "$SECTION_LABELS_DEFAULT_PATH" ]; then
    echo "[Init] Loading from $SECTION_LABELS_DEFAULT_PATH"
    node -e "
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const labelsJson = fs.readFileSync('${SECTION_LABELS_DEFAULT_PATH}', 'utf8');
    await prisma.systemConfig.create({
      data: {
        key: 'section_labels',
        value: labelsJson
      }
    });
    console.log('[Init] Section labels initialized');
  } catch (e) {
    console.log('[Warn] Section labels initialization skipped:', e.message);
  } finally {
    await prisma.\$disconnect();
  }
})();
    " || echo "[Warn] Failed to load section labels"
  else
    echo "[Warn] No default-section-labels.json found"
  fi
else
  echo "[Init] Section labels already exist"
fi

echo "[Init] Starting Proxmox Horizon server..."
exec "$@"
