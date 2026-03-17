# Proxmox Horizon User Manual

This document explains the intended end-user experience and the key features available to regular users in Proxmox Horizon.

## 1. User Experience Philosophy

The user-facing product is designed around a few simple ideas:

- the interface should stay understandable even when the underlying infrastructure is complex
- security should be visible and predictable
- users should be able to request infrastructure without needing full Proxmox expertise

## 2. Screen Layout

Typical user-facing areas include:

- login and OTP pages
- dashboard
- VM list
- VM request form
- profile-related actions such as SSH key download and rotation

## 3. Login And Account Protection

### 3.1 Login Flow

Typical login sequence:

1. enter email and password
2. complete OTP if required
3. enter the dashboard

### 3.2 OTP And Recovery Codes

Users should understand:

- OTP is part of normal account protection
- recovery codes are for loss-of-device situations
- sensitive account actions may ask for OTP again

## 4. Language And Theme

### 4.1 Switching Language

Users can switch the interface language from the supported language options in the UI.

Operational note:

- some strings may remain unchanged until all translations are fully covered in configuration and templates

### 4.2 Personal Theme

Users may customize available theme options according to the UI settings provided by the system.

## 5. What Users Can Do From The Dashboard

The dashboard is the main entry point for day-to-day work.

Typical actions:

- review current VM status
- view request history
- create new VM requests
- access permitted account and key actions

## 6. Viewing My VMs

Users can see the VMs associated with their account or group context.

Common information shown:

- VM name or hostname
- status
- IP address
- related request or job information

## 7. VM Power Control

Where permitted by policy, users can trigger power actions from the UI.

Typical actions:

- start
- stop
- reboot

Expectation:

- power actions depend on policy and backend availability
- a temporary runtime failure does not always mean the UI is wrong; the underlying Proxmox state should be checked when needed

## 8. Deleting A VM

Deletion is a meaningful operational action and should be treated carefully.

Users should confirm:

- the VM is no longer needed
- any important data has been backed up
- the action is allowed for their role and group

## 9. CSV Export

Users may export certain VM-related lists in CSV form where that feature is exposed by the UI.

Typical use cases:

- inventory sharing
- reporting
- internal review

## 10. VM Creation Requests

Users do not directly create VMs in an unrestricted way. They submit structured requests for approval.

Request fields typically include:

- target group
- instance type
- OS
- count
- extra disk requirement
- purpose / justification

### 10.1 OS Selection

The selected OS is used as a hint for the cloud image that the admin will approve for deployment.

Important:

- the actual deployment still depends on what cloud images the administrator has prepared on the Proxmox side

### 10.2 Quotas And Request Limits

Requests may be limited by:

- group quota
- instance policies
- approval requirements
- available prepared infrastructure

## 11. Downloading SSH Keys

Users may be allowed to download their SSH key material through the UI.

Security behavior:

- the system may require OTP re-verification before the download

## 12. Rotating SSH Keys

Users may replace their SSH keys through the UI when the feature is enabled.

Good reasons to rotate:

- key compromise
- scheduled security hygiene
- device replacement

## 13. Frequently Asked Questions

### 13.1 I Changed The Language, But Some Text Is Still Not Translated

This usually means the visible strings come from multiple sources such as templates, configuration, or menu data, and not every string has been translated yet.

### 13.2 Why Does The System Ask For OTP Again When I Download Or Rotate Keys?

Because these are sensitive actions. The extra OTP challenge helps protect account and infrastructure access even if a session is already active.

### 13.3 My Requested VM Was Not Created Immediately

A request may still require:

- admin approval
- quota validation
- prepared cloud image availability
- backend deployment processing

## 14. Related Documents

- [`ADMIN_MANUAL.en.md`](/mnt/d/proxmox-self-service/docs/ADMIN_MANUAL.en.md)
- [`INSTALLATION_MANUAL.en.md`](/mnt/d/proxmox-self-service/docs/INSTALLATION_MANUAL.en.md)
- [`WORKFLOW.en.md`](/mnt/d/proxmox-self-service/docs/WORKFLOW.en.md)
