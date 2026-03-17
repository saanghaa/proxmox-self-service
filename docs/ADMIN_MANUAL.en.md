# Proxmox Horizon Administrator Manual

This document describes the capabilities, expectations, and operational guidelines for administrators using Proxmox Horizon.

## 1. Admin Design Philosophy

The admin area is not just a settings page. It is an operations console.

Core principles:

- Use automation aggressively for repetitive work
- Keep approval and exception handling under explicit admin control
- Re-authenticate sensitive actions such as token viewing or key download
- Leave operational traces through audit logs and notifications
- Assume imperfect real-world environments such as multiple networks, self-signed certificates, and manually prepared cloud images

## 2. Admin UI Overview

Main admin screen:

- `app/src/views/admin.ejs`

Major functional areas:

- VM request approval and rejection
- Proxmox server connections
- user, group, and quota management
- security policy management
- notification settings
- menu and UI text settings
- audit logs and statistics
- backup and restore

## 3. Admin Login And Security

Administrators use the same protected login flow as regular users.

Access pattern:

- log in with the admin account
- complete OTP
- perform sensitive actions only after re-authentication where required

Sensitive actions that require additional OTP confirmation:

- viewing Proxmox token secrets
- downloading SSH keys
- rotating SSH keys

Operational recommendations:

- use personal admin accounts instead of shared accounts whenever possible
- minimize shared credential usage
- review audit logs before resetting OTP for someone else

## 4. Handling VM Creation Requests

Admins review user-submitted VM requests and decide whether to approve or reject them.

Typical review items:

- request group
- instance type
- requested OS
- quantity
- extra disks
- business purpose / justification

Admin responsibilities:

- confirm the request fits policy and quota
- verify the target environment is ready
- approve only when the required cloud image and Proxmox resources are actually available

## 5. Proxmox Server Connections

Admins register one or more Proxmox servers or cluster entry points in Horizon.

### 5.1 Registration Rules

- prefer a reachable management address or URL
- verify TLS behavior and certificate expectations
- confirm the registered endpoint is the one Horizon can actually reach

Cluster note:

- automatic cluster discovery does not eliminate node-local preparation
- if VM deployment uses each node's `local` storage, every target node still needs image and snippet preparation

### 5.2 Viewing Token Secrets

Token viewing is intentionally treated as a sensitive operation.

Expected behavior:

- Horizon prompts for OTP re-verification
- only authorized admins should access the token secret

### 5.3 Deletion Cautions

Before deleting a registered Proxmox connection:

- confirm no active operational workflow depends on it
- verify whether jobs, node records, or admin expectations still reference it

## 6. Cloud Images And Proxmox Host Preparation

Horizon does not automatically invent or fetch every runtime dependency on your behalf.
Admins must ensure Proxmox-side preparation is complete.

Minimum host-side preparation:

1. enable `import` and `snippets` content
2. create the cloud-init snippet file
3. download the cloud images used for deployment
4. register a valid API token in Horizon

Cluster / multi-node note:

- if multiple Proxmox nodes can host Horizon-created VMs, repeat the host-side preparation on every relevant node
- preparing one node does not prepare the other nodes' `local` storage

## 7. User, Group, And Quota Management

Admins are responsible for defining who can request what and in which scope.

Typical tasks:

- create and manage users
- create and manage groups
- assign users to groups
- set quota or resource limits
- review whether request limits match real capacity

Operational guideline:

- group membership should reflect real operational ownership
- quotas should prevent abuse without blocking legitimate work

## 8. Password Policy And Security Policy

Admins can configure security-related policies to enforce minimum operational standards.

Typical concerns:

- password complexity
- OTP enforcement
- session and account protection behavior
- sensitive action re-verification

Recommendation:

- do not weaken security policy merely to work around a temporary operational inconvenience

## 9. VM Management

The admin console includes VM management capabilities for tracking and operational cleanup.

Typical actions:

- view VM records
- export VM data
- restore or delete where permitted
- review deployment history and job status

## 10. VM Synchronization And Migration Reflection

In real environments, VM state can change outside Horizon.

Examples:

- manual migration inside Proxmox
- runtime state changes
- operational cleanup performed directly on the Proxmox side

Admin expectation:

- run synchronization when needed
- treat Horizon as an operational control plane, but verify Proxmox reality when state looks inconsistent

## 11. Statistics And Operational Visibility

Statistics are for operational awareness, not decoration.

Useful questions the dashboard should help answer:

- how many requests are pending
- which groups are most active
- which nodes or resources are heavily used
- whether recent activity suggests a problem or anomaly

## 12. Notification Settings

Admins should configure notifications so that important events are visible without turning the system into noise.

Typical notification targets:

- request approvals / rejections
- deployment results
- security-sensitive events
- operational failures

Recommendation:

- preserve meaningful alerts
- avoid disabling important alerts just because one workflow is noisy

## 13. Audit Logs

Audit logs are a core part of operational trust and post-incident review.

What admins should expect:

- visibility into who performed sensitive actions
- correlation of security-related events
- the ability to review past changes when something looks wrong

## 14. Backup And Restore

Admins should know:

- where backups are created
- how to download or restore them
- the difference between config-only restore and full DB restore
- when a restore has side effects on the running service

## 15. Frequent Operational Problems

### 15.1 Cloud Image Does Not Appear In The Approval Screen

Check:

- `import` content enabled on the storage
- image actually visible via `pvesm list`
- correct node prepared
- cluster target nodes prepared individually if using local storage

### 15.2 Snippet-Related Deployment Failure

Check:

- `snippets` content enabled
- `proxmox-cloud-init.yaml` exists
- the target node has the required file locally

### 15.3 A Node Appears Offline Or Registers With The Wrong Address

Check:

- real reachable management IP / URL
- cluster-discovered addresses
- whether an internal or bridge IP was accidentally stored

### 15.4 Token Viewing Or Sensitive Download Does Not Work

Check:

- OTP re-verification state
- current user permissions
- session validity

## 16. Related Documents

- [`INSTALLATION_MANUAL.en.md`](/mnt/d/proxmox-self-service/docs/INSTALLATION_MANUAL.en.md)
- [`BACKUP_MANUAL.en.md`](/mnt/d/proxmox-self-service/docs/BACKUP_MANUAL.en.md)
- [`USER_MANUAL.en.md`](/mnt/d/proxmox-self-service/docs/USER_MANUAL.en.md)
- [`WORKFLOW.en.md`](/mnt/d/proxmox-self-service/docs/WORKFLOW.en.md)
