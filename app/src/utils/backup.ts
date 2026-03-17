/**
 * Backup Utility
 *
 * Handles PostgreSQL database backup/restore and SystemConfig JSON export/import.
 * Backups are stored as .tar.gz archives in /app/backups (mounted from host).
 *
 * pg_dump/pg_restore are available via postgresql-client installed in the Dockerfile.
 *
 * maintainer_name: Lee Sangha
 * maintainer_email: saanghaa@gmail.com
 * roles: DevOps Engineer, Site Reliability Engineer, Cloud Solutions Architect
 */

import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'fs';
import { join, basename } from 'path';

// Read version from package.json (works in both dev and Docker build)
let _appVersion = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as { version: string };
  _appVersion = pkg.version;
} catch { /* ignore */ }
const APP_VERSION = _appVersion;
import { prisma } from '../services/prisma';

const BACKUP_DIR = '/app/backups';
const BACKUP_PREFIX = 'proxmox-backup-';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BackupMeta {
  filename: string;   // e.g. proxmox-backup-20260221_020000.tar.gz
  size: number;       // bytes
  createdAt: Date;
  hasDb: boolean;
  hasConfig: boolean;
}

export type ScheduleType = 'daily' | 'weekly';

export interface BackupScheduleConfig {
  enabled: boolean;
  scheduleType: ScheduleType;  // 'daily' | 'weekly'
  hour: number;                // 0–23  실행 시각(시)
  weekdays: number[];          // 0=일, 1=월 … 6=토  (weekly 전용)
  retentionDays: number;       // 7, 14, 30
  lastRunAt: string | null;
}

export const DEFAULT_SCHEDULE: BackupScheduleConfig = {
  enabled: false,
  scheduleType: 'daily',
  hour: 2,
  weekdays: [1],   // 월요일
  retentionDays: 7,
  lastRunAt: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureBackupDir(): void {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/**
 * Parse DATABASE_URL to extract connection parameters.
 * Format: postgresql://user:password@host:port/dbname
 */
function parseDbUrl(): { host: string; user: string; password: string; dbname: string; port: string } {
  const url = process.env.DATABASE_URL || '';
  const match = url.match(/^postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/);
  if (!match) throw new Error('Cannot parse DATABASE_URL for backup');
  return {
    user: match[1],
    password: match[2],
    host: match[3],
    port: match[4],
    dbname: match[5],
  };
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '_',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function sanitizeFilename(filename: string): string {
  // Only allow safe characters to prevent path traversal
  const safe = basename(filename).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safe.startsWith(BACKUP_PREFIX) || !safe.endsWith('.tar.gz')) {
    throw new Error('Invalid backup filename');
  }
  return safe;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Create a new backup archive.
 * Includes: PostgreSQL dump (.dump) + SystemConfig JSON + metadata.
 * Returns the filename of the created backup.
 */
export async function createBackup(): Promise<string> {
  ensureBackupDir();

  const timestamp = formatTimestamp();
  const archiveName = `${BACKUP_PREFIX}${timestamp}.tar.gz`;
  const tmpDir = join(BACKUP_DIR, `tmp-${timestamp}`);

  try {
    mkdirSync(tmpDir, { recursive: true });

    const db = parseDbUrl();

    // 1. pg_dump → custom format (compressed)
    const dumpPath = join(tmpDir, 'db.dump');
    execSync(
      `pg_dump -h ${db.host} -p ${db.port} -U ${db.user} -d ${db.dbname} -Fc -f "${dumpPath}"`,
      {
        env: { ...process.env, PGPASSWORD: db.password },
        timeout: 5 * 60 * 1000, // 5 minutes
      }
    );

    // 2. SystemConfig JSON export via Prisma
    const configs = await prisma.systemConfig.findMany();
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(configs, null, 2), 'utf-8');

    // 3. Backup metadata
    const infoPath = join(tmpDir, 'info.json');
    writeFileSync(infoPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      host: process.env.BASE_URL || 'unknown',
      dbHost: db.host,
      dbName: db.dbname,
      author: 'Lee Sangha <saanghaa@gmail.com> (DevOps Engineer, Site Reliability Engineer, Cloud Solutions Architect)',
    }, null, 2), 'utf-8');

    // 4. Create .tar.gz archive
    const archivePath = join(BACKUP_DIR, archiveName);
    execSync(`tar -czf "${archivePath}" -C "${BACKUP_DIR}" "tmp-${timestamp}"`, {
      timeout: 2 * 60 * 1000,
    });

    return archiveName;
  } finally {
    // Always clean up tmp dir
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * List all backup archives in the backup directory.
 */
export function listBackups(): BackupMeta[] {
  ensureBackupDir();

  const files = readdirSync(BACKUP_DIR).filter(
    (f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.tar.gz')
  );

  return files
    .map((filename) => {
      const fullPath = join(BACKUP_DIR, filename);
      const stat = statSync(fullPath);
      return {
        filename,
        size: stat.size,
        createdAt: stat.mtime,
        hasDb: true,
        hasConfig: true,
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Get the absolute path for a backup file (with safety check).
 */
export function getBackupPath(filename: string): string {
  const safe = sanitizeFilename(filename);
  const fullPath = join(BACKUP_DIR, safe);
  if (!existsSync(fullPath)) throw new Error('Backup file not found');
  return fullPath;
}

/**
 * Delete a backup file.
 */
export function deleteBackup(filename: string): void {
  const fullPath = getBackupPath(filename);
  unlinkSync(fullPath);
}

/**
 * Delete backups older than retentionDays.
 * Returns the number of deleted files.
 */
export function pruneOldBackups(retentionDays: number): number {
  ensureBackupDir();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.tar.gz'))
    .forEach((filename) => {
      const fullPath = join(BACKUP_DIR, filename);
      const stat = statSync(fullPath);
      if (stat.mtime.getTime() < cutoff) {
        unlinkSync(fullPath);
        deleted++;
        console.log(`[Backup] Pruned old backup: ${filename}`);
      }
    });

  return deleted;
}

/**
 * Merge notification enabled flags: backup.enabled OR current.enabled.
 * A channel stays ON if either the backup or the current config had it ON.
 * Only goes OFF when both backup and current are OFF (both intentionally disabled).
 */
function mergeNotificationEnabled(backupValue: string, currentValue: string): string {
  try {
    const backup = JSON.parse(backupValue);
    const current = JSON.parse(currentValue);
    for (const channel of ['slack', 'teams', 'email', 'webhook']) {
      if (backup[channel] && typeof backup[channel] === 'object') {
        const currentEnabled = current[channel]?.enabled === true;
        backup[channel].enabled = backup[channel].enabled || currentEnabled;
      }
    }
    return JSON.stringify(backup);
  } catch {
    return backupValue;
  }
}

/**
 * Restore only SystemConfig from a backup archive.
 * Safe to run while the app is running (no service restart needed).
 * notification_config channels are always restored with enabled=true.
 */
export async function restoreConfig(archivePath: string): Promise<void> {
  const timestamp = Date.now();
  const tmpDir = join(BACKUP_DIR, `restore-tmp-${timestamp}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}" --strip-components=1`, {
      timeout: 60 * 1000,
    });

    const configPath = join(tmpDir, 'config.json');
    if (!existsSync(configPath)) throw new Error('config.json not found in backup');

    const configs = JSON.parse(readFileSync(configPath, 'utf-8')) as Array<{
      key: string;
      value: string;
    }>;

    // Read current notification_config before overwriting (for enabled merge)
    const currentNotifRow = await prisma.systemConfig.findUnique({ where: { key: 'notification_config' } });

    // Upsert each SystemConfig entry
    // notification_config: merge enabled flags (backup OR current) to prevent alert silencing
    for (const entry of configs) {
      const value = (entry.key === 'notification_config' && currentNotifRow)
        ? mergeNotificationEnabled(entry.value, currentNotifRow.value)
        : entry.value;

      await prisma.systemConfig.upsert({
        where: { key: entry.key },
        update: { value, updatedAt: new Date() },
        create: {
          id: `sc-restored-${entry.key}-${Date.now()}`,
          key: entry.key,
          value,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    console.log(`[Backup] Config restore completed: ${configs.length} entries`);
  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Restore the full PostgreSQL database from a backup archive.
 * WARNING: Drops and recreates all tables. Triggers app restart via process.exit(0).
 * Docker restart policy (unless-stopped) will bring the service back up.
 */
export async function restoreFullDb(archivePath: string): Promise<void> {
  const timestamp = Date.now();
  const tmpDir = join(BACKUP_DIR, `restore-tmp-${timestamp}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}" --strip-components=1`, {
      timeout: 60 * 1000,
    });

    const dumpPath = join(tmpDir, 'db.dump');
    if (!existsSync(dumpPath)) throw new Error('db.dump not found in backup');

    const db = parseDbUrl();

    // Disconnect Prisma before restore
    await prisma.$disconnect();

    execSync(
      `pg_restore -h ${db.host} -p ${db.port} -U ${db.user} -d ${db.dbname} --clean --if-exists --no-owner "${dumpPath}"`,
      {
        env: { ...process.env, PGPASSWORD: db.password },
        timeout: 10 * 60 * 1000, // 10 minutes
      }
    );

    console.log('[Backup] Full DB restore completed.');

    // 복구 직후 관리자 로그인 복구 보정
    await repairAdminLoginAfterRestore();
  } finally {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Exit after a brief delay so the HTTP response can be sent
  setTimeout(() => process.exit(0), 2000);
}

/**
 * 전체 DB 복구 직후 관리자 계정/권한을 보정합니다.
 * - 관리자 계정 활성 상태 및 권한 보장
 * - mustChangePassword 플래그 정리
 * - 기본 관리자 그룹 매핑 보장
 * 실패 시 non-fatal (복구는 이미 완료됨).
 */
async function repairAdminLoginAfterRestore(): Promise<void> {
  try {
    // 복구 후 Prisma 재연결
    await prisma.$connect();

    const adminEmail = (process.env.INITIAL_ADMIN_EMAIL || '').trim();
    if (!adminEmail) {
      console.warn('[Backup] INITIAL_ADMIN_EMAIL not set; skipping admin login recovery.');
      await prisma.$disconnect();
      return;
    }

    const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });

    if (adminUser) {
      // 활성/권한 상태 보정, 비밀번호 변경 플래그 정리
      await prisma.user.update({
        where: { id: adminUser.id },
        data: {
          isActive: true,
          isAdmin: true,
          mustChangePassword: false,
        },
      });

      // 기본 관리자 그룹 매핑 보장
      const adminGroup = await prisma.group.findFirst({
        where: { name: { contains: 'admin', mode: 'insensitive' } },
      });
      if (adminGroup) {
        await prisma.groupMembership.upsert({
          where: { userId_groupId: { userId: adminUser.id, groupId: adminGroup.id } },
          update: { role: 'admin' },
          create: { userId: adminUser.id, groupId: adminGroup.id, role: 'admin' },
        });
      }

      console.log(`[Backup] Admin login recovery completed for ${adminEmail}`);
    } else {
      console.warn(`[Backup] Admin user not found (${adminEmail}) — skipping recovery`);
    }

    await prisma.$disconnect();
  } catch (e: any) {
    console.warn('[Backup] Admin recovery post-restore failed (non-fatal):', e.message);
  }
}
