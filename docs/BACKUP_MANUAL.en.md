# Proxmox Horizon Backup And Restore Manual

This document explains the backup and restore model used by Proxmox Horizon, including the intended operational behavior of the web UI and CLI scripts.

## UI Reference

The backup and restore flows are part of the Proxmox-themed admin UI and should be understood as operational tooling, not just file upload screens.

## Table Of Contents

The main topics are:

- backup system overview
- restore philosophy
- backup file locations
- backup contents
- web UI workflow
- CLI workflow
- troubleshooting

## 1. Backup System Overview

The current backup flow is designed around application configuration plus database state.

Typical backup elements:

- PostgreSQL dump
- configuration snapshot
- metadata such as creation time and restore context

## 2. Restore Design Philosophy: Preserve Useful Notifications

### Background: A Restore Can Accidentally Silence Notifications

In real operations, a full restore can unintentionally replace current notification settings with older values.
That can make important alerts disappear after recovery.

### Decision: OR-Merge Policy

The intended principle is:

- keep meaningful notifications enabled
- avoid a restore flow that silently disables currently active alerts

### Implementation Direction

Operationally, treat notification preservation as part of safe recovery rather than as a secondary cosmetic detail.

### Relation To Audit Logs

Restores are operationally sensitive and should be reviewable alongside audit evidence.

## 3. Backup File Storage Location

Typical backup path:

- `servers/backups`

Examples:

```bash
ls -lh servers/backups
```

```bash
scp user@server:/path/to/servers/backups/<file>.tar.gz .
```

## 4. What A Backup Contains

A backup archive typically includes:

- database dump
- configuration JSON
- backup metadata / info

The exact package format is designed so that the web UI and CLI scripts can work with the same backup artifacts.

## 5. Web UI: Entering The Backup Tab

The admin UI exposes backup and restore actions in the backup management section.

Typical tasks there:

- create a backup
- list available backups
- download a backup
- restore from a server-side backup
- upload an external backup file and restore it

## 6. Manual Backup Creation

A manual backup is useful before risky operations such as:

- large configuration changes
- schema-sensitive upgrades
- major deployment changes
- emergency maintenance

## 7. Automatic Backup Scheduling

Recommended policy:

- run regular scheduled backups
- keep a retention policy
- verify that the backups are actually being created

Example check:

```bash
crontab -l
```

## 8. Viewing And Downloading Backup Files

Admins should periodically confirm:

- the backup appears in the UI list
- the file exists on disk
- downloads are working

## 9. Restore Directly From A Server Backup

This is the normal restore path when the backup file already exists on the server.

Use cases:

- rollback after a bad deployment
- configuration recovery
- recovery after data corruption

## 10. Restore By Uploading An External Backup File

Use this when:

- the backup was copied from another server
- the server-side backup directory was lost
- support needs to restore from an off-host archive

## 11. Restore Type Comparison: Config Only vs Full DB

Config-only restore:

- safer for targeted configuration recovery
- usually does not require restarting the full application stack
- preferred when user/session/runtime data should remain untouched

Full DB restore:

- restores the whole database state
- has broader impact
- may require container restart or temporary service interruption

Operational rule:

- prefer config-only restore whenever it is enough
- use full DB restore only when a complete rollback is truly required

## 12. CLI Backup / Restore Scripts

### 12.0 `backup-db.sh`: DB Backup Management

This script manages the same backup format used by the UI.

Examples:

```bash
bash scripts/backup-db.sh create
```

```bash
bash scripts/backup-db.sh list
```

```bash
bash scripts/backup-db.sh restore-config <backup-file>
```

```bash
bash scripts/backup-db.sh restore-full <backup-file>
```

```bash
bash scripts/backup-db.sh cleanup 30
```

```bash
bash scripts/backup-db.sh delete <backup-file>
```

### 12.1 `restore-db.sh`: Restore-Focused Script

Recommended mode:

- use the interactive flow when an operator is manually recovering a system

Non-interactive mode is useful for:

- automation
- scripted support procedures

Examples:

```bash
bash scripts/restore-db.sh
```

```bash
bash scripts/restore-db.sh --list
```

```bash
bash scripts/restore-db.sh --config <backup-file>
```

```bash
bash scripts/restore-db.sh --full <backup-file>
```

### Full DB Restore Sequence

The typical full restore path is:

1. identify the target backup
2. create a safety backup if needed
3. stop or pause the app path as required
4. restore the DB dump
5. restart the affected service
6. verify login and runtime behavior

### 12.2 Manual Raw DB Backup

Examples:

```bash
pg_dump -Fc -d "$DATABASE_URL" -f backup.dump
```

```bash
pg_dump -d "$DATABASE_URL" > backup.sql
```

### 12.3 Manual Raw DB Restore

Examples:

```bash
pg_restore --clean --if-exists -d "$DATABASE_URL" backup.dump
```

```bash
psql "$DATABASE_URL" < backup.sql
```

## 13. Backup File Structure

A typical archive contains files such as:

- `db.dump`
- `config.json`
- `info.json`

This structure allows Horizon to inspect backup metadata before restoration.

## 14. Cautions And Troubleshooting

### Important Warning

Before running a restore:

- confirm what scope you are restoring
- understand whether the action restarts services
- keep a fresh safety backup whenever possible

### Troubleshooting

Backup creation fails because `DATABASE_URL` cannot be parsed:

- verify the `.env` value format
- check URL encoding for special characters in the password

Expected format:

```text
postgresql://proxmox:PASSWORD@postgres:5432/proxmox
```

Backup creation fails because `pg_dump` is missing:

- rebuild the app image if the required PostgreSQL client tools are missing

Backup directory permission error:

- verify host-side directory permissions
- restart containers if needed after fixing ownership or permissions

Service does not restart after full restore:

- verify Docker restart policy
- restart the affected container manually if necessary

Login fails after restore:

- verify whether the restored DB state matches the expected accounts and OTP state

Backup file does not appear in the list:

- verify the file exists under the mounted backup directory
- verify the volume mount and file ownership

## Related Files

- [`scripts/backup-db.sh`](/mnt/d/proxmox-self-service/scripts/backup-db.sh)
- [`scripts/restore-db.sh`](/mnt/d/proxmox-self-service/scripts/restore-db.sh)
- [`docs/ADMIN_MANUAL.en.md`](/mnt/d/proxmox-self-service/docs/ADMIN_MANUAL.en.md)
- [`docs/INSTALLATION_MANUAL.en.md`](/mnt/d/proxmox-self-service/docs/INSTALLATION_MANUAL.en.md)
