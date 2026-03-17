# Proxmox Horizon Installation Manual

This document describes the current installation and operational deployment path for Proxmox Horizon, including the practical issues that were encountered during real setup and the solutions that are now reflected in this repository.

## 0. Configuration Summary

### 0.1 Service Composition (Docker Compose)

Compose file:

- `docker-compose.yml`

Services:

- `nginx`: reverse proxy on 80/443
- `app`: Node.js / Express / EJS / Prisma application
- `postgres`: main database
- `redis`: cache and session support

Core environment variables:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `SESSION_SECRET`
- `KEY_ENCRYPTION_SECRET`
- `BASE_URL` (optional)
- `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` (optional first-admin seed)

Reference example:

- `.env.example`

### 0.2 Where Each Command Must Run

The installation process does not happen on one machine only.
Before doing anything else, separate the execution locations clearly.

| Location | Role | Commands / Tasks |
|---|---|---|
| Development / admin PC | edit repo, build release package, copy scripts | `scp`, `bash scripts/make-release-tar.sh` |
| Proxmox Horizon app server | install or update the Docker Compose stack | `bash install.sh`, `bash deploy.sh`, `docker compose ...` |
| Proxmox VE host | storage content setup, cloud image download, token creation | `proxmox-enable-content.sh`, `proxmox-download-cloud-image.sh`, `proxmox-token-rotate.sh` |

Important:

- Run `install.sh` and `deploy.sh` on the Horizon app server.
- Run `proxmox-enable-content.sh`, `proxmox-download-cloud-image.sh`, and `proxmox-token-rotate.sh` on a Proxmox VE host.
- Proxmox VE usually does not provide `sudo`, so host-side tasks are normally executed directly as `root`.
- In a cluster, node-local preparation is still required on every node that may host Horizon-created VMs.

## 1. Choose The Installation Path: `install.sh` vs `deploy.sh`

### 1.1 First-Time Installation (Init): `install.sh`

Script:

- `install.sh`

Goal:

- Build and start the app through Docker without requiring local Node/npm build tooling on the host
- Avoid hardcoded domain or localhost behavior and rely on `BASE_URL` only when needed

Basic usage:

```bash
bash install.sh
```

```bash
bash install.sh --init
```

```bash
bash install.sh --init --user admin@example.com --passwd 'Example123!'
```

Operational note:

- `bash install.sh` without `--init` prints help and exits
- The real installation starts only with `--init`
- This behavior intentionally prevents accidental destructive runs

### 1.2 Rolling Operational Update: `deploy.sh`

Script:

- `deploy.sh`

Goal:

- Keep existing data
- Rebuild updated images
- Replace running containers with the latest code

Usage:

```bash
bash deploy.sh
```

When to use which:

- `install.sh --init`: first install or intentional destructive reset
- `deploy.sh`: normal operational code deployment

## 2. Pre-Installation Requirements

### 2.1 Host Requirements

- Linux host that can run Docker and Docker Compose
- Sufficient disk space for images, containers, uploads, database data, and backups
- Reachability to the Proxmox API endpoint used by Horizon
- Reverse proxy ports and TLS path prepared as needed

### 2.2 `BASE_URL` Policy

Do not hardcode localhost or an environment-specific URL into the application source.

Recommended rule:

- Leave `BASE_URL` empty unless a fixed external URL is actually required
- Set it explicitly only when reverse proxy / TLS / external callback behavior requires a canonical public URL

### 2.3 DB Schema Migration

The application uses Prisma migrations as part of the container startup path.

Migration expectations:

- The image should include the latest schema
- Startup should run `prisma migrate deploy`
- A mismatch between code and schema will usually surface immediately during startup

Common migration history to keep in mind:

- authentication / OTP related schema changes
- VM request and Proxmox integration changes
- audit / notification / configuration related changes

## 3. Common Problems And Fixes

### 3.1 OTP Setup Page (`/auth/otp-setup`) Returns 500

Likely causes:

- broken view/template state
- route and template mismatch
- stale build or image

What to check:

- redeploy the latest source
- make sure the updated EJS templates are included in the image
- confirm no stale image layer is still running

### 3.2 Prisma P1000 / Broken `DATABASE_URL`

Typical symptom:

- database authentication fails
- the URL contains an unescaped password and multiple `@` characters

Fix:

- URL-encode special characters in the DB password
- verify the final `DATABASE_URL` format carefully

Expected form:

```text
postgresql://user:PASSWORD@postgres:5432/dbname
```

### 3.3 Cloud Image List Is Empty / Extra Disk Auto-Mount Fails

This is one of the most important real-world Proxmox setup issues.

Key facts:

- It is not enough for an image file to merely exist under `/var/lib/vz/import`
- The storage must expose `import` content in `/etc/pve/storage.cfg`
- The cloud-init snippet file must exist and `snippets` content must also be enabled
- Horizon depends on these Proxmox-side resources before deployment begins

Minimum checks:

```bash
cat /etc/pve/storage.cfg
```

```bash
pvesh get /nodes/<node>/storage/local/content
```

```bash
pvesm list local --content import
```

```bash
ls -l /var/lib/vz/snippets/proxmox-cloud-init.yaml
```

Cluster note:

- If you use multiple Proxmox nodes and rely on node-local `local` storage, each deployment target node must be prepared separately.
- Enabling `import` and `snippets` on one node does not magically prepare the other nodes' local image availability.

### Proxmox Host Shell Script Guide

#### Execution Order Summary

Recommended order on the Proxmox VE host:

1. `proxmox-enable-content.sh`
2. `proxmox-download-cloud-image.sh`
3. `proxmox-token-rotate.sh`

If needed, first copy the scripts from the development PC or app server to the Proxmox VE host.

#### 1) `proxmox-enable-content.sh`

Purpose:

- Enable `import` and `snippets` on `local` storage
- Create `proxmox-cloud-init.yaml`

Recommended command:

```bash
bash proxmox-enable-content.sh
```

Optional examples:

```bash
bash proxmox-enable-content.sh --all --force-snippet
```

```bash
bash proxmox-enable-content.sh --dry-run
```

Cluster note:

- Run this on every node that can host deployed VMs.

#### 2) `proxmox-download-cloud-image.sh`

Purpose:

- Download a Proxmox-managed cloud image into import storage

Recommended command:

```bash
bash proxmox-download-cloud-image.sh
```

Optional examples:

```bash
bash proxmox-download-cloud-image.sh --preset rocky-10
```

```bash
bash proxmox-download-cloud-image.sh --url https://example.com/image.qcow2
```

```bash
bash proxmox-download-cloud-image.sh --list-presets
```

Cluster note:

- In a multi-node cluster that uses local storage, download the image on each target node separately.

#### 3) `proxmox-token-rotate.sh`

Purpose:

- Create or rotate the Proxmox API token used by Horizon

Recommended command:

```bash
bash proxmox-token-rotate.sh
```

Optional example:

```bash
bash proxmox-token-rotate.sh proxmox@pam proxmox
```

Operational note:

- This is usually done once, then the resulting token is registered in the Horizon admin UI.

#### Recommended Initial Setup Sequence

Run these on the Proxmox VE host:

```bash
bash proxmox-enable-content.sh
bash proxmox-download-cloud-image.sh
bash proxmox-token-rotate.sh
```

Then on the Horizon app server:

```bash
bash install.sh --init
```

#### Validation

Run on the Proxmox VE host:

```bash
pvesm list local --content import
```

```bash
pvesm list local --content snippets
```

```bash
ls -l /var/lib/vz/snippets/proxmox-cloud-init.yaml
```

#### Final Step In Horizon Admin UI

- Open the Proxmox connection page in the admin console
- Register the Proxmox node / API endpoint
- Enter the generated `Token ID` and `Token Secret`
- Verify connectivity and node discovery

### 3.4 Gateway Auto-Detection Picks A Bridge IP Instead

If a bridge or internal IP is detected instead of the desired gateway:

- verify the real routable gateway
- review node network layout and bridge settings
- correct the setting manually in the Horizon admin UI if required

### 3.5 Browser Console Shows Tracking Prevention Warnings

Warnings about blocked access to storage for CDN resources are usually browser privacy warnings rather than Horizon server failures.

What matters:

- confirm whether the page is actually broken
- if necessary, avoid external CDN dependencies in deployment builds

### 3.6 Deployment Ends As `PARTIAL`

Typical causes:

- invalid cloud image volid format
- selected image not visible in import content yet
- `snippets` content missing
- snippet file missing

Checks:

- the selected value must look like `storage:import/<file>`
- the corresponding storage must expose `import`
- the node must have the snippet file available

## 4. Build And Deployment Rules

To avoid the classic problem of "I changed `src`, but the server still serves old behavior":

- rebuild the image whenever code changes
- prefer `deploy.sh` for operational deployment
- use a no-cache rebuild only when troubleshooting stale layers
- verify the running container actually came from the rebuilt image

## 5. Minimum Proxmox Token / Permission Requirements

Operational checklist:

- the API token must be valid
- the token must have enough permissions to inspect nodes, storage, VMs, and related resources
- Horizon must be able to list nodes and storage content
- the token should be tested from the Horizon admin UI immediately after creation

## 6. Post-Install Checks

### 6.1 Container Status

```bash
docker compose ps
```

### 6.2 Web Response

```bash
curl -I http://127.0.0.1
```

### 6.3 Initial Admin Login

- open the application in the browser
- create the first admin if `/setup` is shown
- log in
- complete OTP

## 7. Operational Script Guide

### 7.1 DB Backup: `backup-db.sh`

Main tasks:

- create backup archive
- list backups
- restore config only
- restore full DB
- delete old backups

Examples:

```bash
bash scripts/backup-db.sh create
```

```bash
bash scripts/backup-db.sh list
```

```bash
bash scripts/backup-db.sh restore-config <file>
```

```bash
bash scripts/backup-db.sh restore-full <file>
```

### 7.2 DB Restore: `restore-db.sh`

Main tasks:

- interactive restore
- list backups
- config-only restore
- full DB restore

### 7.3 Nginx Log Rotation: `rotate-nginx-logs.sh`

Use this script to rotate reverse proxy logs and combine it with cron if needed.

### 7.4 OTP Reset: `otp-reset.sh`

Use this when an account must re-enroll OTP after support review and audit confirmation.

### 7.5 Audit IP Trace: `audit-ip-trace.sh`

Use this to correlate audit records and request paths with observed IP data.

### 7.6 Diagnostic Tarball: `diagnose-internal-error.sh`

Use this to package logs and current runtime state when a 500 or similar operational failure must be investigated.

### 7.7 Release Tarball: `make-release-tar.sh`

Use this when the deployment flow relies on copying a release archive to a target server instead of cloning directly on the server.

## 8. HTTPS Without A Certificate

If you do not yet have a proper certificate:

- start with HTTP or a self-signed certificate only for temporary testing
- keep the final operational path focused on valid TLS termination
- make sure `BASE_URL`, reverse proxy behavior, and browser expectations all match the actual public entry point

## Related Files

- [`install.sh`](/mnt/d/proxmox-self-service/install.sh)
- [`deploy.sh`](/mnt/d/proxmox-self-service/deploy.sh)
- [`docker-compose.yml`](/mnt/d/proxmox-self-service/docker-compose.yml)
- [`scripts/proxmox-enable-content.sh`](/mnt/d/proxmox-self-service/scripts/proxmox-enable-content.sh)
- [`scripts/proxmox-download-cloud-image.sh`](/mnt/d/proxmox-self-service/scripts/proxmox-download-cloud-image.sh)
- [`scripts/proxmox-token-rotate.sh`](/mnt/d/proxmox-self-service/scripts/proxmox-token-rotate.sh)
- [`scripts/backup-db.sh`](/mnt/d/proxmox-self-service/scripts/backup-db.sh)
