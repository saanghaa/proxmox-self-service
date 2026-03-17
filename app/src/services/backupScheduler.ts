/**
 * Backup Scheduler Service
 *
 * Reads backup schedule from SystemConfig key "backup_schedule".
 * Checks every 10 minutes whether a backup is due, then runs createBackup().
 *
 * Schedule types:
 *   daily  — every day at schedule.hour (e.g. 02:xx)
 *   weekly — on schedule.weekdays[] at schedule.hour
 *
 * "Due" logic: current hour matches schedule.hour AND lastRunAt is not today
 * (for weekly: also current weekday must be in schedule.weekdays).
 */

import { prisma } from './prisma';
import {
  createBackup,
  pruneOldBackups,
  BackupScheduleConfig,
  DEFAULT_SCHEDULE,
} from '../utils/backup';
import { notifyAuditEvent } from './slack';

// ─── State ────────────────────────────────────────────────────────────────────

let checkInterval: NodeJS.Timeout | null = null;
let initialTimeout: NodeJS.Timeout | null = null;
let isRunning = false;

// ─── Schedule helpers ─────────────────────────────────────────────────────────

export async function getBackupSchedule(): Promise<BackupScheduleConfig> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: 'backup_schedule' } });
    if (!row) return { ...DEFAULT_SCHEDULE };
    return { ...DEFAULT_SCHEDULE, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export async function saveBackupSchedule(config: BackupScheduleConfig): Promise<void> {
  const value = JSON.stringify(config);
  await prisma.systemConfig.upsert({
    where: { key: 'backup_schedule' },
    update: { value, updatedAt: new Date() },
    create: {
      id: `sc-backup-schedule-${Date.now()}`,
      key: 'backup_schedule',
      value,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

// ─── Due Check ────────────────────────────────────────────────────────────────

/**
 * Returns true if the schedule is due right now.
 * Uses "same calendar date" guard so it never runs twice in the same day
 * even if the server restarts mid-hour.
 */
function isDue(schedule: BackupScheduleConfig): boolean {
  const now = new Date();
  const currentHour = now.getHours();

  // Hour must match
  if (currentHour !== schedule.hour) return false;

  // Weekly: weekday must be in the list
  if (schedule.scheduleType === 'weekly') {
    const currentWeekday = now.getDay(); // 0=Sun … 6=Sat
    if (!schedule.weekdays.includes(currentWeekday)) return false;
  }

  // Same-day guard: skip if already ran today
  if (schedule.lastRunAt) {
    const lastDate = new Date(schedule.lastRunAt).toDateString();
    if (lastDate === now.toDateString()) return false;
  }

  return true;
}

// ─── Core Check ───────────────────────────────────────────────────────────────

async function checkAndRunBackup(): Promise<void> {
  if (isRunning) return;

  try {
    const schedule = await getBackupSchedule();
    if (!schedule.enabled) return;

    if (!isDue(schedule)) return;

    isRunning = true;
    console.log('[BackupScheduler] Starting scheduled backup...');

    const filename = await createBackup();
    console.log(`[BackupScheduler] Scheduled backup created: ${filename}`);

    // Update lastRunAt
    const updated: BackupScheduleConfig = {
      ...schedule,
      lastRunAt: new Date().toISOString(),
    };
    await saveBackupSchedule(updated);

    // Notify backup created
    notifyAuditEvent({
      action: 'backup_created',
      result: 'SUCCESS',
      reason: `자동 스케줄 백업: ${filename}`,
    }).catch(() => {});

    // Prune old backups
    const pruned = pruneOldBackups(schedule.retentionDays);
    if (pruned > 0) {
      console.log(`[BackupScheduler] Pruned ${pruned} old backup(s)`);
    }
  } catch (err) {
    console.error('[BackupScheduler] Scheduled backup failed:', err);

    // Notify backup failed
    notifyAuditEvent({
      action: 'backup_failed',
      result: 'FAIL',
      reason: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  } finally {
    isRunning = false;
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function startBackupScheduler(): void {
  console.log('[BackupScheduler] Starting...');

  // First check after 5 minutes (let the app fully start up)
  initialTimeout = setTimeout(() => checkAndRunBackup(), 5 * 60 * 1000);

  // Then check every 10 minutes (hour-precision matching, but catches restarts near the boundary)
  checkInterval = setInterval(() => checkAndRunBackup(), 10 * 60 * 1000);
}

export function stopBackupScheduler(): void {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  console.log('[BackupScheduler] Stopped.');
}

/**
 * Reload the scheduler after a schedule config change.
 * Stops and restarts to pick up the new config on next check.
 */
export function reloadBackupScheduler(): void {
  stopBackupScheduler();
  startBackupScheduler();
}
