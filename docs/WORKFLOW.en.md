# Install And Deploy Flow

This document explains how `install.sh` and `deploy.sh` work in practice, based on the current scripts and application code in this repository.

- Initial installation: `install.sh`
- Operational deployment: `deploy.sh`
- App bootstrap: `app/docker-entrypoint.sh`
- App runtime: `app/src/server.ts`

## Overview

This repository is not designed to run every script on a single machine.
You must clearly separate commands that run on the Horizon application server from commands that run directly on a Proxmox VE host.

| Execution Location | Script / File | Purpose |
|---|---|---|
| Proxmox Horizon app server | `install.sh` | Prepares Docker / Docker Compose, creates `.env`, prepares persistent directories, and starts the containers for the first time. |
| Proxmox Horizon app server | `deploy.sh` | Rebuilds images and replaces containers without deleting existing operational data. |
| Proxmox Horizon app server | `scripts/backup-db.sh` | Creates a backup archive from the running `postgres` container and current app configuration. |
| Proxmox VE host | `scripts/proxmox-enable-content.sh` | Enables `import` and `snippets` content on Proxmox storage and prepares the default cloud-init snippet file. |
| Proxmox VE host | `scripts/proxmox-download-cloud-image.sh` | Downloads Ubuntu or Rocky cloud images into Proxmox import storage. |
| Proxmox VE host | `scripts/proxmox-token-rotate.sh` | Creates or rotates the Proxmox API user/token used by Horizon and grants the required permissions. |

### Files That Must Run On A Proxmox VE Host

The following three scripts must be executed on a Proxmox VE host shell as `root`, not on the Docker-based Horizon app server.

Cluster / multi-node note:

- In a cluster, this preparation does not finish after running the scripts on one node.
- The current operational assumption is node-local `local` storage.
- That means every node that may host Horizon-created VMs must have `import`, `snippets`, and the required cloud images prepared locally.
- In practice, run and verify `proxmox-enable-content.sh` and `proxmox-download-cloud-image.sh` on each deployment target node.
- `proxmox-token-rotate.sh` is usually performed once, and the resulting token is then registered in Horizon.

#### 1. `scripts/proxmox-enable-content.sh`

What it does:

- Ensures the selected Proxmox storage includes `import` and `snippets` in `/etc/pve/storage.cfg`
- Creates `/var/lib/vz/snippets/proxmox-cloud-init.yaml` if needed
- Prepares the cloud-init resources Horizon expects during VM deployment

When to run it:

- First-time environment setup
- When `local` storage content settings are broken
- When a node in the cluster has not yet been prepared

Example:

```bash
sudo bash scripts/proxmox-enable-content.sh
```

Notes:

- By default it prepares `local` storage, enables `import` and `snippets`, and creates the default snippet file.
- `--all` is optional and only makes that same intent more explicit.
- The current documented operational path assumes `local` storage.
- In a cluster, repeat this on every node that can receive deployed VMs.

#### 2. `scripts/proxmox-download-cloud-image.sh`

What it does:

- Submits a Proxmox `download-url` task through `pvesh`
- Downloads Ubuntu Noble, Rocky 10, or a custom image URL into import storage
- Waits for task completion so the resulting image is visible as Proxmox-managed import content

When to run it:

- When the cloud image is not yet available
- When adding or replacing an operating system image
- When another cluster node still lacks the required image

Example:

```bash
sudo bash scripts/proxmox-download-cloud-image.sh
```

Notes:

- By default it downloads `ubuntu-noble` to the current host's node name, `local` storage, and `import` content.
- In normal operation, keeping images in each node's `local` storage is the expected path.
- Use `--node <name>` only when the current hostname does not match the intended node target.
- Use `--preset rocky-10` or `--url <image-url>` only when you need a different image.
- In a cluster, download the image separately on each target node's `local` storage.

#### 3. `scripts/proxmox-token-rotate.sh`

What it does:

- Uses `pveum` to check, create, or rotate the Proxmox user and API token
- Grants `Administrator` permissions on `/`
- Prints the final `Token ID` and `Token Secret` used in the Horizon admin UI

When to run it:

- Before the first Horizon-Proxmox integration
- When the token is leaked, expired, or must be rotated

Example:

```bash
bash scripts/proxmox-token-rotate.sh
```

Notes:

- If you run it without arguments, it prompts for values and falls back to `proxmox@pam` and `proxmox` when left blank.
- Use `bash scripts/proxmox-token-rotate.sh <user_id> <token_name>` only when you want a different user or token name.

### Files That Must Not Run On A Proxmox VE Host

The following files are operational app-server scripts, not Proxmox VE host scripts.

- `install.sh`: first-time Docker-based installation or destructive reinstall with `--init`
- `deploy.sh`: rolling update on the Horizon app server
- `scripts/backup-db.sh`: backup of the app server's `postgres` container and config

## 1. Initial Installation Flow: `install.sh`

### Example Commands

```bash
bash install.sh
```

```bash
bash install.sh --init
```

```bash
bash install.sh --init --user admin@example.com --passwd 'Example123!'
```

Important:

- `bash install.sh` without options prints usage and exits.
- This is intentional to avoid starting a destructive unattended installation by mistake.
- Actual installation starts only with `--init`.
- The first admin account can be created later in the browser at `/setup`, or automatically with `--user` and `--passwd`.

### Supported Options

| Option | Meaning | Current Behavior |
|---|---|---|
| `--init` | Initialize installation | Deletes existing data and reinstalls |
| `--user EMAIL` | Set initial admin email | Auto-creates the first admin when used with `--init` |
| `--passwd PASS` | Set initial admin password | Auto-creates the first admin when used with `--init` |

Current behavior:

- `bash install.sh` with no arguments prints usage and exits
- Real installation starts only with `bash install.sh --init`

### Installation Flow

```text
[Administrator]
  |
  | bash install.sh [options]
  v
[install.sh]
  |
  |-- 1. Parse arguments
  |     - --init
  |     - --user
  |     - --passwd
  |
  |-- 2. Run basic checks
  |     - confirm docker-compose.yml exists
  |     - confirm sudo exists
  |
  |-- 3. Check Docker / Docker Compose
  |     - install with apt if missing
  |     - try to register docker group
  |
  |-- 4. Run source preflight checks
  |     - old template/route combination checks
  |     - CDN reference checks
  |     - admin.ejs TDZ risk check
  |
  |-- 5. Create persistent directories
  |
  |-- 6. If --init
  |     - ask for YES confirmation
  |     - back up .env and servers snapshot
  |     - docker compose down -v
  |     - delete DB/Redis/uploads/logs
  |     - delete .env
  |
  |-- 7. Handle .env
  |     - keep it if present
  |     - create it automatically if missing
  |
  |-- 8. Optionally prepare first admin seed
  |
  |-- 9. Start containers
  |     - docker compose up -d --build
  |
  |-- 10. Check Postgres health
  |
  v
[Installation complete]
```

### `--init` Details

`bash install.sh --init` removes and recreates the following data:

- `./servers/postgres/data`
- `./servers/redis/data`
- `./servers/app/uploads`
- `./servers/app/logs`
- `./.env`

Important:

- `KEY_ENCRYPTION_SECRET` is regenerated, so encrypted data stored in the old database may no longer be compatible.
- Do not use `--init` if you need to preserve operational data.

### First Admin Creation

Method 1. Create in the web UI

- After installation, open `/setup`
- Create the first admin account in the browser

Method 2. Create via CLI options

```bash
bash install.sh --init --user admin@example.com --passwd 'Example123!'
```

## 2. Container Composition Flow: `docker-compose.yml`

The Docker Compose stack contains:

- `nginx`
- `app`
- `postgres`
- `redis`

### Container Relationships

- `nginx` receives HTTP/HTTPS traffic and proxies requests to `app`
- `app` runs the Node.js / Express / Prisma application
- `postgres` stores system data
- `redis` is used for cache and session-related support

### Persistent Data Locations

- `servers/app/uploads`
- `servers/app/logs`
- `servers/postgres/data`
- `servers/postgres/backups`
- `servers/redis/data`
- `servers/nginx/certs`
- `servers/nginx/logs`
- `servers/backups`

## 3. App Bootstrap Flow: `app/docker-entrypoint.sh`

The entrypoint prepares the application before the actual Node server starts.

### Flow

```text
[container start]
  |
  |-- load env
  |-- ensure defaults/config files
  |-- run Prisma generate
  |-- run Prisma migrate deploy
  |-- seed initial data if needed
  |-- start Node server
```

### Default Config Priority

In general, the app follows this order:

1. existing persisted config/data
2. environment variables
3. built-in defaults shipped with the application

## 4. App Runtime Flow: `app/src/server.ts`

The runtime server bootstraps middleware, sessions, routes, static assets, and UI state.

### Flow

```text
[start]
  |
  |-- load configuration
  |-- connect DB / cache dependencies
  |-- register middleware
  |-- register routes / APIs / views
  |-- serve UI and APIs
```

### First Access Behavior

- On a brand new installation, the system guides the operator to `/setup`
- After the first admin is created, the normal login flow is used

### Normal User Flow

- Login
- Complete OTP
- Open dashboard
- View VMs, request VMs, or perform permitted actions

## 5. Operational Deployment Flow: `deploy.sh`

### Example

```bash
bash deploy.sh
```

### Behavior

- Keeps existing data
- Rebuilds updated images
- Replaces containers through Docker Compose
- Applies rolling operational updates instead of destructive reinstallation

### Supported Style

- Intended for code updates on an already installed server
- Not intended to recreate the whole environment from scratch

### Deployment Flow

```text
[Administrator]
  |
  | bash deploy.sh
  v
[deploy.sh]
  |
  |-- basic validation
  |-- source / image rebuild
  |-- docker compose up -d --build
  |-- container replacement
  |-- health / runtime checks
  v
[Deployment complete]
```

### Difference Between `install.sh` And `deploy.sh`

- `install.sh --init`: destructive reinstall for first setup or full reset
- `deploy.sh`: operational update that preserves existing data

## 6. Recommended Operational Procedure

### First Installation

1. Prepare each Proxmox node that may host VMs
2. Run `proxmox-enable-content.sh` on each target node
3. Run `proxmox-download-cloud-image.sh` on each target node
4. Run `proxmox-token-rotate.sh`
5. Register the token in Horizon
6. Run `bash install.sh --init` on the Horizon app server
7. Create the first admin at `/setup` or with CLI options

### Apply Code Changes

```bash
bash deploy.sh
```

### Force A Rebuild Without Cache

Use Docker Compose build options when troubleshooting a stale image, but keep this as an exception rather than the default operational path.

### Reinstall From Scratch Only When Absolutely Necessary

Use `install.sh --init` only when you intentionally want to destroy and recreate the application data and secrets.

## 7. Related Files

- [`install.sh`](/mnt/d/proxmox-self-service/install.sh)
- [`deploy.sh`](/mnt/d/proxmox-self-service/deploy.sh)
- [`docker-compose.yml`](/mnt/d/proxmox-self-service/docker-compose.yml)
- [`scripts/proxmox-enable-content.sh`](/mnt/d/proxmox-self-service/scripts/proxmox-enable-content.sh)
- [`scripts/proxmox-download-cloud-image.sh`](/mnt/d/proxmox-self-service/scripts/proxmox-download-cloud-image.sh)
- [`scripts/proxmox-token-rotate.sh`](/mnt/d/proxmox-self-service/scripts/proxmox-token-rotate.sh)
- [`app/docker-entrypoint.sh`](/mnt/d/proxmox-self-service/app/docker-entrypoint.sh)
- [`app/src/server.ts`](/mnt/d/proxmox-self-service/app/src/server.ts)
- [`app/src/routes/ui.ts`](/mnt/d/proxmox-self-service/app/src/routes/ui.ts)
