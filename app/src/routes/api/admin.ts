import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import sshpk from "sshpk";
import { prisma } from "../../services/prisma";
import { requireLogin } from "../middlewares/requireLogin";
import { requireAdmin } from "../middlewares/requireAdmin";
import { writeAudit } from "../../services/audit";
import { NOTIFICATION_EVENT_KEYS, notifyAuditEvent } from "../../services/slack";
import { SMTP_PRESETS, sendTestEmail, type EmailProvider } from "../../services/email";
import { encryptText, decryptText } from "../../services/crypto";
import { verifyTotp } from "../../services/totp";
import { getGroupQuotaUsage } from "../../services/quotaService";
import { getPasswordPolicy } from "../../config/passwordPolicy";
import { ProxmoxClient } from "../../services/proxmox";
import type { MenuConfig } from "../../types/menu";
import { getDefaultMenuConfig } from "../../utils/defaultMenuConfig";
import { getClientIp } from "../../utils/requestIp";
import { toLegacyFormat, loadUIElements, loadLabels, type SupportedLanguage } from "../../utils/labelLoader";
import { getAutoRotatePolicy, saveAutoRotatePolicy, calcNextRunAt, triggerAutoRotation, type AutoRotatePolicy } from "../../services/autoRotate";
import {
  getUIStrings,
  getDefaultUIStrings,
  saveUIStringOverrides,
  resetUIStrings,
} from "../../utils/uiStringLoader";
import {
  createBackup,
  listBackups,
  getBackupPath,
  deleteBackup,
  restoreConfig,
  restoreFullDb,
} from "../../utils/backup";
import {
  getBackupSchedule,
  saveBackupSchedule,
  reloadBackupScheduler,
} from "../../services/backupScheduler";
import { syncAllVmStatuses } from "../../services/vmSyncService";
import { isValidTemplate, getTemplateOptions, resolveTemplate } from "../../utils/themeTemplates";

/** CSV 필드 이스케이프 (쉼표·따옴표·개행 포함 시 따옴표로 래핑) */
function csvEscape(val: string | number | null | undefined): string {
  const str = val == null ? '' : String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Multer configuration for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    // Accept only specific file types for SSH keys
    const allowedMimes = ['application/x-pem-file', 'text/plain', 'application/octet-stream'];
    const allowedExts = ['.pem', '.key', '.pub', '.txt', ''];
    const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();

    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only .pem, .key, .pub, or .txt files are allowed.'));
    }
  }
});

// Multer configuration for backup restore uploads (disk storage, up to 500MB)
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `restore-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.tar.gz') || file.mimetype === 'application/gzip' || file.mimetype === 'application/x-tar') {
      cb(null, true);
    } else {
      cb(new Error('Only .tar.gz backup files are allowed'));
    }
  },
});

/**
 * SSH ???占쎌씪 泥섎━ 占?fingerprint 怨꾩궛
 * ?占쎈줈?占쎈맂 private key濡쒙옙???public key占?異붿텧?占쎄퀬 fingerprint占?怨꾩궛?占쎈땲??
 * OpenSSH ?占쎌떇???占쎈룞?占쎈줈 PEM ?占쎌떇?占쎈줈 蹂?占쏀빀?占쎈떎.
 */
function processUploadedSSHKey(privateKeyContent: string, publicKeyContent?: string) {
  try {
    // Private key validation - check if it's a valid key format
    if (!privateKeyContent.includes('BEGIN') || !privateKeyContent.includes('PRIVATE KEY')) {
      throw new Error('Invalid private key format - must contain BEGIN and PRIVATE KEY markers');
    }

    let privateKeyPEM: string;
    let publicKey: string;

    // Detect key format and convert if necessary
    if (privateKeyContent.includes('BEGIN OPENSSH PRIVATE KEY')) {
      console.log('Detected OpenSSH format key, converting to PEM...');
      try {
        // Parse OpenSSH key using sshpk
        const parsedKey = sshpk.parsePrivateKey(privateKeyContent, 'openssh');

        // Convert to PEM format (PKCS8)
        privateKeyPEM = parsedKey.toString('pkcs8');

        // Get public key in SSH format
        const parsedPublicKey = parsedKey.toPublic();
        publicKey = parsedPublicKey.toString('ssh');

        console.log('Successfully converted OpenSSH key to PEM format');
      } catch (sshpkError: any) {
        console.error('sshpk parsing error:', sshpkError);
        throw new Error(`Failed to parse OpenSSH key: ${sshpkError.message}`);
      }
    } else {
      // Already in PEM format, use as-is
      privateKeyPEM = privateKeyContent;

      // If public key provided, use it; otherwise derive from private key
      if (publicKeyContent) {
        publicKey = publicKeyContent.trim();
      } else {
        try {
          const parsedKey = sshpk.parsePrivateKey(privateKeyPEM, 'pem');
          const parsedPublicKey = parsedKey.toPublic();
          publicKey = parsedPublicKey.toString('ssh');
        } catch (sshpkError: any) {
          throw new Error(`Failed to derive public key: ${sshpkError.message}`);
        }
      }
    }

    // Generate fingerprint using Node.js crypto
    const keyObject = crypto.createPrivateKey(privateKeyPEM);
    const derivedPublicKey = crypto.createPublicKey(keyObject);
    const publicKeyPEM = derivedPublicKey.export({
      type: 'spki',
      format: 'pem'
    }) as string;

    const hash = crypto.createHash('sha256');
    hash.update(publicKeyPEM);
    const fingerprint = `SHA256:${hash.digest('base64').replace(/=+$/, '')}`;

    return {
      privateKey: privateKeyPEM, // Return PEM format for storage
      publicKey,
      fingerprint
    };
  } catch (error: any) {
    console.error('SSH key processing error:', error);
    throw new Error(`Failed to process SSH key: ${error.message}`);
  }
}

/**
 * 鍮꾬옙?踰덊샇 蹂듭옟??寃占? */
async function validatePasswordComplexity(password: string): Promise<{ valid: boolean; error?: string }> {
  const policy = await getPasswordPolicy();

  if (password.length < policy.minLength) {
    return { valid: false, error: "PASSWORD_TOO_SHORT" };
  }
  if (policy.complexity.requireUppercase && !/[A-Z]/.test(password)) {
    return { valid: false, error: "PASSWORD_MISSING_UPPERCASE" };
  }
  if (policy.complexity.requireLowercase && !/[a-z]/.test(password)) {
    return { valid: false, error: "PASSWORD_MISSING_LOWERCASE" };
  }
  if (policy.complexity.requireNumbers && !/[0-9]/.test(password)) {
    return { valid: false, error: "PASSWORD_MISSING_NUMBER" };
  }
  if (policy.complexity.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    return { valid: false, error: "PASSWORD_MISSING_SPECIAL" };
  }
  return { valid: true };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeNotificationHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
    if (!k) {
      return acc;
    }
    acc[k] = typeof v === "string" ? v : String(v ?? "");
    return acc;
  }, {});
}

function parseDiskSizeFromConfigToGb(configValue: string): number | null {
  const match = String(configValue || "").match(/size=(\d+(?:\.\d+)?)([TGMK])/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = String(match[2] || "").toUpperCase();
  if (!Number.isFinite(num)) return null;
  if (unit === "T") return Math.round(num * 1024);
  if (unit === "G") return Math.round(num);
  if (unit === "M") return Math.max(1, Math.round(num / 1024));
  return null;
}

function parseIpFromIpconfig(ipconfig?: string | null): string | null {
  if (!ipconfig) return null;
  const match = String(ipconfig).match(/(?:^|,)ip=([^,]+)/i);
  if (!match || !match[1]) return null;
  const raw = String(match[1]).trim();
  if (!raw) return null;
  if (/^(dhcp|auto)$/i.test(raw)) return null;
  const ip = raw.split("/")[0]?.trim() || "";
  if (!ip || /^(dhcp|auto)$/i.test(ip)) return null;
  return ip;
}

function parseVmIpFromConfig(config: Record<string, any>): string | null {
  if (!config || typeof config !== "object") return null;

  const ipconfigKeys = Object.keys(config)
    .filter((k) => /^ipconfig\d+$/i.test(k))
    .sort((a, b) => {
      const ai = parseInt(a.replace(/^\D+/g, ""), 10);
      const bi = parseInt(b.replace(/^\D+/g, ""), 10);
      return ai - bi;
    });

  for (const key of ipconfigKeys) {
    const ip = parseIpFromIpconfig(String((config as any)[key] || ""));
    if (ip) return ip;
  }

  return null;
}

function parseIpFromGuestInterfaces(interfaces: any): string | null {
  if (!Array.isArray(interfaces)) return null;

  for (const nic of interfaces) {
    const addrs = Array.isArray(nic?.["ip-addresses"]) ? nic["ip-addresses"] : [];
    for (const addr of addrs) {
      const type = String(addr?.["ip-address-type"] || "").toLowerCase();
      const ip = String(addr?.["ip-address"] || "").trim();
      if (!ip) continue;
      if (type !== "ipv4") continue;
      if (ip.startsWith("127.")) continue;
      return ip;
    }
  }

  return null;
}

function parseFirstIpv4(text: string): string | null {
  if (!text) return null;
  const candidates = String(text).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  for (const c of candidates) {
    if (c.startsWith("127.")) continue;
    const ok = c.split(".").every((n) => {
      const v = Number(n);
      return Number.isInteger(v) && v >= 0 && v <= 255;
    });
    if (ok) return c;
  }
  return null;
}

function sumDiskSizeGbFromVmConfig(config: Record<string, any>): number | null {
  const slots = Object.keys(config || {}).filter((k) => /^(scsi|virtio|sata|ide)\d+$/i.test(k));
  if (slots.length === 0) return null;
  let total = 0;
  for (const slot of slots) {
    const raw = String((config as any)[slot] || "");
    if (!raw || raw.includes("media=cdrom")) continue;
    const sizeGb = parseDiskSizeFromConfigToGb(raw);
    if (sizeGb && sizeGb > 0) total += sizeGb;
  }
  return total > 0 ? total : null;
}

async function postJsonWebhook(url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`UPSTREAM_HTTP_${response.status}`);
  }
}

export const adminApi = Router();

// ?占쏀뤃??愿由ъ옄 怨꾩젙 (seed?占쎌꽌 ?占쎌꽦, 鍮꾪솢?占쏀솕/沅뚰븳蹂占?遺덌옙?)
const DEFAULT_ADMIN_EMAIL = (process.env.INITIAL_ADMIN_EMAIL || "").trim();

// 紐⑤뱺 愿由ъ옄 ?占쎌슦?占쎈뒗 濡쒓렇??+ 愿由ъ옄 沅뚰븳 ?占쎌닔
adminApi.use(requireLogin, requireAdmin);

/**
 * GET /api/admin/users - ?占쎌껜 ?占쎌슜??紐⑸줉 (洹몃９ 硫ㅻ쾭???占쏀븿)
 */
adminApi.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true, email: true, isActive: true, isAdmin: true,
      totpEnabled: true, createdAt: true,
      memberships: {
        include: { group: { select: { id: true, name: true } } }
      }
    },
    orderBy: { createdAt: "asc" }
  });
  res.json({ ok: true, users });
});

/**
 * POST /api/admin/users - ?占쎌슜???占쎌꽦
 * Body: { email, password, isAdmin?, groupId? }
 */
adminApi.post("/users", async (req, res) => {
  const { email, password, isAdmin, groupId } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "MISSING_FIELDS" });
  }

  // Password complexity check
  const complexityCheck = await validatePasswordComplexity(password);
  if (!complexityCheck.valid) {
    return res.status(400).json({ error: complexityCheck.error });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        passwordLastChanged: new Date(),
        isAdmin: isAdmin || false
      }
    });

    if (groupId) {
      await prisma.groupMembership.create({
        data: { userId: user.id, groupId, role: "member" }
      });
    }

    await writeAudit({
      userId: req.user!.id, action: "USER_CREATE", result: "SUCCESS",
      reason: `Created user: ${email}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true, userId: user.id });
  } catch (e: any) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "EMAIL_ALREADY_EXISTS" });
    }
    console.error("[Admin] User creation error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/users/:id/deactivate - ?占쎌슜??鍮꾪솢?占쏀솕 (1?占쎄퀎)
 */
adminApi.patch("/users/:id/deactivate", async (req, res) => {
  const { id } = req.params;

  if (id === req.user!.id) {
    return res.status(400).json({ error: "CANNOT_DEACTIVATE_SELF" });
  }

  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { email: true, isActive: true } });
    if (!target) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    if (target.email === DEFAULT_ADMIN_EMAIL) {
      return res.status(403).json({ error: "CANNOT_MODIFY_DEFAULT_ADMIN" });
    }

    await prisma.user.update({ where: { id }, data: { isActive: false } });

    await writeAudit({
      userId: req.user!.id, action: "USER_DEACTIVATE", result: "SUCCESS",
      reason: `Deactivated user: ${target.email}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] User deactivation error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/users/:id/activate - ?占쎌슜???占쎌꽦?? */
adminApi.patch("/users/:id/activate", async (req, res) => {
  const { id } = req.params;

  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { email: true, isActive: true } });
    if (!target) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    await prisma.user.update({ where: { id }, data: { isActive: true } });

    await writeAudit({
      userId: req.user!.id, action: "USER_ACTIVATE", result: "SUCCESS",
      reason: `Activated user: ${target.email}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] User activation error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * DELETE /api/admin/users/:id - ?占쎌슜???占쎌쟾 ??占쏙옙 (2?占쎄퀎, 鍮꾪솢?占쏀솕???占쎌슜?占쎈쭔)
 */
adminApi.delete("/users/:id", async (req, res) => {
  const { id } = req.params;

  if (id === req.user!.id) {
    return res.status(400).json({ error: "CANNOT_DELETE_SELF" });
  }

  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { email: true, isActive: true } });
    if (!target) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    if (target.email === DEFAULT_ADMIN_EMAIL) {
      return res.status(403).json({ error: "CANNOT_MODIFY_DEFAULT_ADMIN" });
    }

    // 鍮꾪솢?占쏀솕?占쏙옙? ?占쏙옙? ?占쎌슜?占쎈뒗 ??占쏙옙 遺덌옙?
    if (target.isActive) {
      return res.status(400).json({ error: "USER_MUST_BE_DEACTIVATED_FIRST" });
    }

    // 愿???占쎌퐫???占쎈━ ???占쎌슜????占쏙옙 (?占쎈옖??占쏙옙)
    await prisma.$transaction([
      // 1. 媛먯궗 濡쒓렇??userId 李몄“占?null占?蹂占?(濡쒓렇 蹂댁〈)
      prisma.auditLog.updateMany({ where: { userId: id }, data: { userId: null } }),
      // 2. 洹몃９ 硫ㅻ쾭????占쏙옙
      prisma.groupMembership.deleteMany({ where: { userId: id } }),
      // 3. ?占쎌슜????占쏙옙
      prisma.user.delete({ where: { id } }),
    ]);

    await writeAudit({
      userId: req.user!.id, action: "USER_DELETE", result: "SUCCESS",
      reason: `Deleted user: ${target.email}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] User deletion error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/users/:id/reset-password - 鍮꾬옙?踰덊샇 珥덇린?? * Body: { newPassword }
 */
adminApi.patch("/users/:id/reset-password", async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: "MISSING_PASSWORD" });

  // Password complexity check
  const complexityCheck = await validatePasswordComplexity(newPassword);
  if (!complexityCheck.valid) {
    return res.status(400).json({ error: complexityCheck.error });
  }

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        passwordLastChanged: new Date()
      }
    });

    await writeAudit({
      userId: req.user!.id, action: "USER_RESET_PASSWORD", result: "SUCCESS",
      reason: `Reset password for user: ${id}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] Password reset error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/users/:id/reset-otp - OTP 珥덇린??(?占쎈벑占??占쎈룄)
 */
adminApi.patch("/users/:id/reset-otp", async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.user.update({
      where: { id },
      data: { totpSecret: null, totpEnabled: false }
    });

    await writeAudit({
      userId: req.user!.id, action: "USER_RESET_OTP", result: "SUCCESS",
      reason: `Reset OTP for user: ${id}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] OTP reset error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * DELETE /api/admin/users/:id/groups - ?占쎌슜?占쎌쓽 紐⑤뱺 洹몃９ 硫ㅻ쾭????占쏙옙
 */
adminApi.delete("/users/:id/groups", async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.groupMembership.deleteMany({ where: { userId: id } });

    await writeAudit({
      userId: req.user!.id, action: "USER_REMOVE_ALL_GROUPS", result: "SUCCESS",
      reason: `Removed all group memberships for user: ${id}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] Remove user groups error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/users/:id/toggle-admin - Admin 沅뚰븳 ?占쏙옙?
 */
adminApi.patch("/users/:id/toggle-admin", async (req, res) => {
  const { id } = req.params;

  if (id === req.user!.id) {
    return res.status(400).json({ error: "CANNOT_CHANGE_OWN_ADMIN_STATUS" });
  }

  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { email: true, isAdmin: true } });
    if (!target) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    if (target.email === DEFAULT_ADMIN_EMAIL) {
      return res.status(403).json({ error: "CANNOT_MODIFY_DEFAULT_ADMIN" });
    }

    const newAdminStatus = !target.isAdmin;
    await prisma.user.update({ where: { id }, data: { isAdmin: newAdminStatus } });

    await writeAudit({
      userId: req.user!.id, action: "USER_ENABLE_ADMIN", result: "SUCCESS",
      reason: `${newAdminStatus ? 'Granted' : 'Revoked'} admin privileges for user: ${target.email}`,
      requestIp: getClientIp(req), userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true, isAdmin: newAdminStatus });
  } catch (e: any) {
    console.error("[Admin] Enable admin error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/groups - ?占쎌껜 洹몃９ 紐⑸줉
 */
adminApi.get("/groups", async (req, res) => {
  const groups = await prisma.group.findMany({
    include: {
      members: {
        include: { user: { select: { id: true, email: true } } }
      },
      _count: { select: { vms: true, jobs: true } }
    },
    orderBy: { createdAt: "asc" }
  });
  res.json({ ok: true, groups });
});

/**
 * POST /api/admin/groups - 洹몃９ ?占쎌꽦
 * Body: { name }
 */
adminApi.post("/groups", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "MISSING_NAME" });

  try {
    const group = await prisma.group.create({ data: { name } });
    res.json({ ok: true, groupId: group.id });
  } catch (e: any) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "GROUP_ALREADY_EXISTS" });
    }
    console.error("[Admin] Group creation error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/groups/:groupId - 洹몃９占??占쎌젙
 * Body: { name }
 */
adminApi.patch("/groups/:groupId", async (req, res) => {
  const { groupId } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "MISSING_NAME" });
  }

  try {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) {
      return res.status(404).json({ error: "GROUP_NOT_FOUND" });
    }

    const oldName = group.name;
    await prisma.group.update({
      where: { id: groupId },
      data: { name: name.trim() }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "GROUP_UPDATE",
      result: "SUCCESS",
      groupId: groupId,
      reason: `Updated group name: "${oldName}" ??"${name.trim()}"`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "GROUP_NAME_EXISTS", message: "A group with this name already exists" });
    }
    console.error("[Admin] Group update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * DELETE /api/admin/groups/:groupId - 洹몃９ ??占쏙옙
 * 硫ㅻ쾭, VM, Job???占쎈뒗 洹몃９占???占쏙옙 媛?? */
adminApi.delete("/groups/:groupId", async (req, res) => {
  const { groupId } = req.params;

  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: true,
        vms: { where: { deletedAt: null } },
      }
    });

    if (!group) {
      return res.status(404).json({ error: "GROUP_NOT_FOUND" });
    }

    // Active members: block
    if (group.members.length > 0) {
      return res.status(400).json({
        error: "GROUP_HAS_MEMBERS",
        message: `Cannot delete group with ${group.members.length} member(s). Remove all members first.`
      });
    }

    // Active VMs: block
    if (group.vms.length > 0) {
      return res.status(400).json({
        error: "GROUP_HAS_VMS",
        message: `Cannot delete group with ${group.vms.length} active VM(s). Remove or reassign all VMs first.`
      });
    }

    // Auto-clean related admin records
    await prisma.vm.deleteMany({ where: { groupId } });
    await prisma.vmRequest.deleteMany({ where: { groupId } });
    await prisma.deployTask.deleteMany({ where: { groupId } });
    await prisma.job.deleteMany({ where: { groupId } });
    await prisma.groupQuota.deleteMany({ where: { groupId } });

    await prisma.group.delete({ where: { id: groupId } });

    await writeAudit({
      userId: req.user!.id,
      action: "GROUP_DELETE",
      result: "SUCCESS",
      groupId: groupId,
      reason: `Deleted group: ${group.name}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] Group deletion error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /api/admin/groups/:groupId/members - 洹몃９???占쎌슜??諛곗젙
 * Body: { userId, role? }
 */
adminApi.post("/groups/:groupId/members", async (req, res) => {
  const { groupId } = req.params;
  const { userId, role } = req.body;
  if (!userId) return res.status(400).json({ error: "MISSING_USER_ID" });

  try {
    await prisma.groupMembership.create({
      data: { userId, groupId, role: role || "member" }
    });
    res.json({ ok: true });
  } catch (e: any) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "ALREADY_MEMBER" });
    }
    console.error("[Admin] Group member add error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * DELETE /api/admin/groups/:groupId/members/:userId - 洹몃９?占쎌꽌 ?占쎌슜???占쎄굅
 */
adminApi.delete("/groups/:groupId/members/:userId", async (req, res) => {
  const { groupId, userId } = req.params;

  try {
    await prisma.groupMembership.deleteMany({ where: { groupId, userId } });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] Group member remove error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/users/:id/change-group - ?占쎌슜??洹몃９ 蹂占? * Body: { newGroupId }
 */
adminApi.patch("/users/:id/change-group", async (req, res) => {
  const { id } = req.params;
  const { newGroupId } = req.body;

  if (!newGroupId) {
    return res.status(400).json({ error: "MISSING_GROUP_ID" });
  }

  try {
    // 洹몃９ 議댁옱 ?占쎌씤
    const group = await prisma.group.findUnique({ where: { id: newGroupId } });
    if (!group) {
      return res.status(404).json({ error: "GROUP_NOT_FOUND" });
    }

    // Replace user group membership
    await prisma.$transaction(async (tx) => {
      // 1. 湲곗〈 洹몃９ 硫ㅻ쾭????占쏙옙
      await tx.groupMembership.deleteMany({
        where: { userId: id }
      });

      // 2. ??洹몃９ 硫ㅻ쾭???占쎌꽦
      await tx.groupMembership.create({
        data: {
          userId: id,
          groupId: newGroupId,
          role: "member"
        }
      });
    });

    await writeAudit({
      userId: req.user!.id,
      action: "USER_CHANGE_GROUP",
      result: "SUCCESS",
      reason: `Changed user ${id} to group ${group.name}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] User group change error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/vms - ?占쎌껜 VM 紐⑸줉 議고쉶
 */
adminApi.get("/vms", async (req, res) => {
  try {
    const vms = await prisma.vm.findMany({
      include: {
        group: { select: { id: true, name: true } },
        job: { select: { jobId: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ ok: true, vms });
  } catch (e: any) {
    console.error("[Admin] VM list error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/vms/:id/change-group - VM 洹몃９ 蹂占?(媛쒕퀎 VM占??占쎈룞)
 * Body: { newGroupId }
 */
adminApi.patch("/vms/:id/change-group", async (req, res) => {
  const { id } = req.params;
  const { newGroupId } = req.body;

  if (!newGroupId) {
    return res.status(400).json({ error: "MISSING_GROUP_ID" });
  }

  try {
    // VM 議댁옱 ?占쎌씤 (湲곗〈 洹몃９ ?占쎈낫 ?占쏀븿)
    const vm = await prisma.vm.findUnique({
      where: { id },
      select: {
        id: true,
        vmid: true,
        hostname: true,
        groupId: true,
        group: { select: { name: true } }
      }
    });

    if (!vm) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    // 洹몃９ 議댁옱 ?占쎌씤
    const newGroup = await prisma.group.findUnique({ where: { id: newGroupId } });
    if (!newGroup) {
      return res.status(404).json({ error: "GROUP_NOT_FOUND" });
    }

    // VM占??占쎈룞 (媛숋옙? Job???占쏀븳 ?占쎈Ⅸ VM?占쎌뿉???占쏀뼢 ?占쎌쓬)
    await prisma.vm.update({
      where: { id },
      data: { groupId: newGroupId }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_CHANGE_GROUP",
      result: "SUCCESS",
      vmId: id,
      groupId: newGroupId,
      reason: `Moved VM ${vm.hostname || vm.vmid} to group ${newGroup.name}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
      vmHostname: vm.hostname || `VM-${vm.vmid}`,
      oldGroupName: vm.group.name,
      newGroupName: newGroup.name,
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] VM group change error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/vms/:id - VM 필드 편집 (수동 등록 VM 수정용)
 * Body: multipart/form-data { vmid?, hostname?, ip?, node?, cpuCores?, memoryMb?, diskSizeGb?, groupId?, privateKey?(file), publicKey?(file) }
 */
adminApi.patch("/vms/:id",
  upload.fields([{ name: "privateKey", maxCount: 1 }, { name: "publicKey", maxCount: 1 }]),
  async (req, res) => {
    const { id } = req.params;
    const { vmid, hostname, ip, node, cpuCores, memoryMb, diskSizeGb, groupId } = req.body;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    try {
      const vm = await prisma.vm.findUnique({
        where: { id },
        include: { group: { select: { name: true } } }
      });
      if (!vm) return res.status(404).json({ error: "VM_NOT_FOUND" });

      if (vmid && parseInt(String(vmid)) !== vm.vmid) {
        const dup = await prisma.vm.findFirst({ where: { vmid: parseInt(String(vmid)), id: { not: id } } });
        if (dup) return res.status(409).json({ error: "VMID_ALREADY_EXISTS" });
      }

      if (groupId && groupId !== vm.groupId) {
        const group = await prisma.group.findUnique({ where: { id: groupId } });
        if (!group) return res.status(404).json({ error: "GROUP_NOT_FOUND" });
      }

      await prisma.vm.update({
        where: { id },
        data: {
          vmid: vmid ? parseInt(String(vmid)) : undefined,
          hostname: hostname !== undefined ? hostname : undefined,
          ip: ip !== undefined ? (ip || null) : undefined,
          node: node !== undefined ? (node || null) : undefined,
          cpuCores: cpuCores !== undefined ? (cpuCores ? parseInt(String(cpuCores)) : null) : undefined,
          memoryMb: memoryMb !== undefined ? (memoryMb ? parseInt(String(memoryMb)) : null) : undefined,
          diskSizeGb: diskSizeGb !== undefined ? (diskSizeGb ? parseInt(String(diskSizeGb)) : null) : undefined,
          groupId: groupId || undefined,
        }
      });

      let keyUpdated = false;
      if (files?.privateKey?.length) {
        const privateKeyContent = files.privateKey[0].buffer.toString("utf-8");
        const publicKeyContent = files.publicKey?.[0]?.buffer.toString("utf-8");

        const { privateKey, publicKey, fingerprint } = processUploadedSSHKey(privateKeyContent, publicKeyContent);
        const privateKeyEnc = encryptText(privateKey);
        const keyVersion = `uploaded-${Date.now()}`;

        const existingKey = await prisma.key.findUnique({ where: { fingerprint } });
        if (!existingKey) {
          await prisma.key.create({ data: { fingerprint, keyVersion, publicKey, privateKeyEnc } });
        }

        if (vm.jobId) {
          await prisma.job.update({
            where: { jobId: vm.jobId },
            data: { keyFingerprint: fingerprint }
          });
        }
        keyUpdated = true;
      }

      await writeAudit({
        userId: req.user!.id,
        action: "VM_EDIT",
        result: "SUCCESS",
        vmId: id,
        groupId: groupId || vm.groupId,
        reason: `Edited VM ${hostname || vm.hostname || vm.vmid}${keyUpdated ? " (SSH key updated)" : ""}`,
        requestIp: getClientIp(req),
        userAgent: req.get("user-agent") || ""
      });

      res.json({ ok: true });
    } catch (e: any) {
      console.error("[Admin] VM edit error:", e);
      res.status(500).json({ error: "INTERNAL_ERROR", message: e?.message });
    }
  }
);



/**
 * GET /api/admin/audit-logs - 媛먯궗 濡쒓렇 議고쉶 (?占쎌씠吏?占쎌씠??
 * Query: ?page=1&limit=50
 */
adminApi.get("/audit-logs", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const skip = (page - 1) * limit;
  const from = (req.query.from as string) || "";
  const to = (req.query.to as string) || "";
  const user = ((req.query.user as string) || "").trim();
  const action = ((req.query.action as string) || "").trim();
  const result = ((req.query.result as string) || "").trim();
  const ip = ((req.query.ip as string) || "").trim();
  const q = ((req.query.q as string) || "").trim();

  try {
    const where: any = {};

    if (from || to) {
      where.createdAt = {};
      if (from) {
        const fromDate = new Date(from);
        if (!isNaN(fromDate.getTime())) where.createdAt.gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        if (!isNaN(toDate.getTime())) where.createdAt.lte = toDate;
      }
      if (Object.keys(where.createdAt).length === 0) delete where.createdAt;
    }
    if (user) where.user = { email: { contains: user, mode: "insensitive" } };
    if (action) where.action = { contains: action, mode: "insensitive" };
    if (result === "SUCCESS") {
      where.result = "SUCCESS";
    } else if (result === "FAILURE") {
      // UI의 FAIL 필터는 SUCCESS가 아닌 모든 결과(FAILURE/PARTIAL 등)를 포함
      where.result = { not: "SUCCESS" };
    }
    if (ip) where.requestIp = { contains: ip, mode: "insensitive" };
    if (q) where.reason = { contains: q, mode: "insensitive" };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip, take: limit,
        include: { user: { select: { email: true } } }
      }),
      prisma.auditLog.count({ where })
    ]);

    res.json({ ok: true, logs, total, page, limit });
  } catch (e: any) {
    console.error("[Admin] Audit log query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/jobs - ?占쎌껜 Job 紐⑸줉 議고쉶
 */
adminApi.get("/jobs", async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      include: {
        group: { select: { id: true, name: true } },
        vms: { select: { id: true } },
        key: { select: { fingerprint: true, keyVersion: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ ok: true, jobs });
  } catch (e: any) {
    console.error("[Admin] Job list error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/vms/:id/assign-job - VM??Job ?占쎈떦
 * Body: { jobId }
 */
adminApi.patch("/vms/:id/assign-job", async (req, res) => {
  const { id } = req.params;
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: "MISSING_JOB_ID" });
  }

  try {
    // VM 議댁옱 ?占쎌씤
    const vm = await prisma.vm.findUnique({
      where: { id },
      select: { id: true, vmid: true, hostname: true, jobId: true }
    });

    if (!vm) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    // Job 議댁옱 ?占쎌씤
    const job = await prisma.job.findUnique({
      where: { jobId },
      select: { jobId: true, groupId: true }
    });

    if (!job) {
      return res.status(404).json({ error: "JOB_NOT_FOUND" });
    }

    // VM??Job ?占쎈떦
    await prisma.vm.update({
      where: { id },
      data: { jobId }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_ASSIGN_JOB",
      result: "SUCCESS",
      vmId: id,
      jobId,
      reason: `Assigned Job ${jobId.substring(0, 8)} to VM ${vm.hostname || vm.vmid}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] VM job assignment error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/password-policy - 鍮꾬옙?踰덊샇 ?占쎌콉 議고쉶
 */
adminApi.get("/password-policy", async (req, res) => {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "password_policy" }
    });

    if (!config) {
      // 湲곕낯 ?占쎌콉 諛섑솚
      return res.json({
        ok: true,
        policy: {
          expiryDays: 90,
          warningDays: 7,
          minLength: 8,
          complexity: {
            requireUppercase: true,
            requireLowercase: true,
            requireNumbers: true,
            requireSpecialChars: true
          }
        }
      });
    }

    res.json({ ok: true, policy: JSON.parse(config.value) });
  } catch (e: any) {
    console.error("[Admin] Password policy query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/password-policy - 鍮꾬옙?踰덊샇 ?占쎌콉 ?占쎈뜲?占쏀듃
 * Body: { expiryDays, warningDays, minLength, complexity }
 */
adminApi.patch("/password-policy", async (req, res) => {
  const { expiryDays, warningDays, minLength, complexity } = req.body;

  // Validate values
  if (expiryDays < 0 || warningDays < 0 || minLength < 1) {
    return res.status(400).json({ error: "INVALID_POLICY_VALUES" });
  }

  try {
    const policy = {
      expiryDays: parseInt(expiryDays),
      warningDays: parseInt(warningDays),
      minLength: parseInt(minLength),
      complexity: {
        requireUppercase: !!complexity.requireUppercase,
        requireLowercase: !!complexity.requireLowercase,
        requireNumbers: !!complexity.requireNumbers,
        requireSpecialChars: !!complexity.requireSpecialChars
      }
    };

    await prisma.systemConfig.upsert({
      where: { key: "password_policy" },
      create: {
        key: "password_policy",
        value: JSON.stringify(policy)
      },
      update: {
        value: JSON.stringify(policy)
      }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "PASSWORD_POLICY_UPDATE",
      result: "SUCCESS",
      reason: `Updated password policy: expiry=${expiryDays}d, warning=${warningDays}d, minLength=${minLength}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true, policy });
  } catch (e: any) {
    console.error("[Admin] Password policy update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/session-policy - 세션 보안 정책 조회
 */
adminApi.get("/session-policy", async (_req, res) => {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "session_policy" }
    });

    if (!config) {
      return res.json({
        ok: true,
        policy: {
          maxHours: 12,
          idleMinutes: 30
        }
      });
    }

    const parsed = JSON.parse(config.value || "{}");
    const policy = {
      maxHours: Number(parsed.maxHours) || 12,
      idleMinutes: Number(parsed.idleMinutes) || 30
    };
    return res.json({ ok: true, policy });
  } catch (e: any) {
    console.error("[Admin] Session policy query error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/session-policy - 세션 보안 정책 저장
 * Body: { maxHours, idleMinutes }
 */
adminApi.patch("/session-policy", async (req, res) => {
  const maxHours = parseInt(String(req.body?.maxHours), 10);
  const idleMinutes = parseInt(String(req.body?.idleMinutes), 10);

  if (!Number.isFinite(maxHours) || maxHours < 1 || maxHours > 24) {
    return res.status(400).json({ error: "INVALID_MAX_HOURS" });
  }
  if (!Number.isFinite(idleMinutes) || idleMinutes < 5 || idleMinutes > 240) {
    return res.status(400).json({ error: "INVALID_IDLE_MINUTES" });
  }

  try {
    const policy = { maxHours, idleMinutes };
    await prisma.systemConfig.upsert({
      where: { key: "session_policy" },
      create: {
        key: "session_policy",
        value: JSON.stringify(policy)
      },
      update: {
        value: JSON.stringify(policy)
      }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "SESSION_POLICY_UPDATE",
      result: "SUCCESS",
      reason: `Updated session policy: maxHours=${maxHours}, idleMinutes=${idleMinutes}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    return res.json({ ok: true, policy });
  } catch (e: any) {
    console.error("[Admin] Session policy update error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/key-rotate-policy - 키 교체 권한 정책 조회
 */
adminApi.get("/key-rotate-policy", async (req, res) => {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "key_rotate_mode" }
    });
    const mode = config ? config.value : "admin_only";
    return res.json({ ok: true, mode });
  } catch (e: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/key-rotate-policy - 키 교체 권한 정책 변경
 * Body: { mode: "admin_only" | "group_member" }
 */
adminApi.patch("/key-rotate-policy", async (req, res) => {
  const { mode } = req.body || {};
  if (mode !== "admin_only" && mode !== "group_member") {
    return res.status(400).json({ error: "INVALID_MODE" });
  }
  try {
    await prisma.systemConfig.upsert({
      where: { key: "key_rotate_mode" },
      create: { key: "key_rotate_mode", value: mode },
      update: { value: mode },
    });
    await writeAudit({
      userId: req.user!.id,
      action: "KEY_ROTATE_POLICY_UPDATE",
      result: "SUCCESS",
      reason: `key_rotate_mode → ${mode}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });
    return res.json({ ok: true, mode });
  } catch (e: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/auto-rotate-policy - 자동 교체 정책 조회
 */
adminApi.get("/auto-rotate-policy", async (req, res) => {
  try {
    const policy = await getAutoRotatePolicy();
    const nextRunAt = calcNextRunAt(policy);
    return res.json({ ok: true, policy, nextRunAt: nextRunAt?.toISOString() ?? null });
  } catch (e: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/auto-rotate-policy - 자동 교체 정책 저장
 */
adminApi.patch("/auto-rotate-policy", async (req, res) => {
  const { enabled, scheduleMode, intervalDays, intervalMonths, dayOfMonth, runAtHour, runAtMinute, targetTypes } = req.body || {};

  if (scheduleMode !== undefined && scheduleMode !== "interval" && scheduleMode !== "monthly") {
    return res.status(400).json({ error: "INVALID_SCHEDULE_MODE" });
  }
  if (intervalDays !== undefined && (isNaN(intervalDays) || intervalDays < 1)) {
    return res.status(400).json({ error: "INVALID_INTERVAL_DAYS" });
  }
  if (dayOfMonth !== undefined && (isNaN(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) {
    return res.status(400).json({ error: "INVALID_DAY_OF_MONTH" });
  }
  if (runAtHour !== undefined && (isNaN(runAtHour) || runAtHour < 0 || runAtHour > 23)) {
    return res.status(400).json({ error: "INVALID_RUN_AT_HOUR" });
  }
  if (runAtMinute !== undefined && (isNaN(runAtMinute) || runAtMinute < 0 || runAtMinute > 59)) {
    return res.status(400).json({ error: "INVALID_RUN_AT_MINUTE" });
  }
  if (targetTypes !== undefined && !Array.isArray(targetTypes)) {
    return res.status(400).json({ error: "INVALID_TARGET_TYPES" });
  }

  try {
    const current = await getAutoRotatePolicy();
    const updated: AutoRotatePolicy = {
      ...current,
      ...(enabled !== undefined && { enabled: !!enabled }),
      ...(scheduleMode !== undefined && { scheduleMode }),
      ...(intervalDays !== undefined && { intervalDays: parseInt(intervalDays) }),
      ...(intervalMonths !== undefined && { intervalMonths: parseInt(intervalMonths) }),
      ...(dayOfMonth !== undefined && { dayOfMonth: parseInt(dayOfMonth) }),
      ...(runAtHour !== undefined && { runAtHour: parseInt(runAtHour) }),
      ...(runAtMinute !== undefined && { runAtMinute: parseInt(runAtMinute) }),
      ...(targetTypes !== undefined && { targetTypes }),
    };
    await saveAutoRotatePolicy(updated);

    await writeAudit({
      userId: req.user!.id,
      action: "AUTO_ROTATE_POLICY_UPDATE",
      result: "SUCCESS",
      reason: `mode=${updated.scheduleMode}, enabled=${updated.enabled}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    const nextRunAt = calcNextRunAt(updated);
    return res.json({ ok: true, policy: updated, nextRunAt: nextRunAt?.toISOString() ?? null });
  } catch (e: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /api/admin/auto-rotate-policy/run-now - 즉시 실행
 */
adminApi.post("/auto-rotate-policy/run-now", async (req, res) => {
  try {
    const result = await triggerAutoRotation(true);
    await writeAudit({
      userId: req.user!.id,
      action: "AUTO_ROTATE_MANUAL_TRIGGER",
      result: result.failures.length === 0 ? "SUCCESS" : "PARTIAL",
      reason: result.failures.length > 0 ? result.failures.join("; ") : "All VMs rotated",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });
    return res.json({ ok: true, ...result });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/vms/manual/probe?vmid=123&node=pve01
 * Proxmox에서 기존 VM 정보를 조회해 수동 등록 폼 자동 채움에 사용
 */
adminApi.get("/vms/manual/probe", async (req, res) => {
  const vmid = parseInt(String(req.query.vmid || ""), 10);
  const requestedNode = String(req.query.node || "").trim();

  if (!Number.isInteger(vmid) || vmid < 100) {
    return res.status(400).json({ error: "INVALID_VMID" });
  }

  const existing = await prisma.vm.findFirst({ where: { vmid } });
  if (existing) {
    return res.status(409).json({ error: "VMID_ALREADY_EXISTS" });
  }

  const pveNodes = requestedNode
    ? await prisma.pveNode.findMany({ where: { name: requestedNode }, orderBy: { createdAt: "asc" } })
    : await prisma.pveNode.findMany({ where: { isOnline: true }, orderBy: { createdAt: "asc" } });
  if (pveNodes.length === 0) {
    return res.status(404).json({ error: requestedNode ? "NODE_NOT_FOUND" : "NO_ONLINE_NODE" });
  }

  for (const pveNode of pveNodes) {
    try {
      const client = new ProxmoxClient(pveNode.host, pveNode.tokenId, decryptText(pveNode.tokenSecret));
      const vmListRes = await client.getVmList(pveNode.name);
      if (!vmListRes.ok || !Array.isArray(vmListRes.data)) continue;

      const vmInfo = vmListRes.data.find((v) => Number(v.vmid) === vmid);
      if (!vmInfo) continue;

      const cfgRes = await client.getVmConfig(pveNode.name, vmid);
      const cfg = (cfgRes.ok && cfgRes.data && typeof cfgRes.data === "object") ? cfgRes.data as Record<string, any> : {};

      const hostname = String(cfg.name || vmInfo.name || `vm-${vmid}`).trim();
      let ip = parseVmIpFromConfig(cfg) || null;
      if (!ip) {
        const guestNetRes = await client.agentNetworkGetInterfaces(pveNode.name, vmid);
        if (guestNetRes.ok && Array.isArray(guestNetRes.data)) {
          ip = parseIpFromGuestInterfaces(guestNetRes.data) || null;
        }
      }
      if (!ip) {
        // Some guest-agent versions may not return interfaces reliably.
        // Fallback to agent exec (Linux first, then Windows).
        const linuxProbe = await client.agentExec(pveNode.name, vmid, ["bash", "-lc", "hostname -I 2>/dev/null | awk '{print $1}'"]);
        if (linuxProbe.ok && linuxProbe.data?.pid) {
          const linuxStatus = await client.agentExecStatus(pveNode.name, vmid, Number(linuxProbe.data.pid));
          if (linuxStatus.ok) {
            ip = parseFirstIpv4(String(linuxStatus.data?.["out-data"] || ""));
          }
        }
      }
      if (!ip) {
        const winProbe = await client.agentExec(pveNode.name, vmid, [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*'} | Select-Object -First 1 -ExpandProperty IPAddress)"
        ]);
        if (winProbe.ok && winProbe.data?.pid) {
          const winStatus = await client.agentExecStatus(pveNode.name, vmid, Number(winProbe.data.pid));
          if (winStatus.ok) {
            ip = parseFirstIpv4(String(winStatus.data?.["out-data"] || ""));
          }
        }
      }
      const cpuCores = cfg.cores != null
        ? parseInt(String(cfg.cores), 10)
        : (vmInfo.cpus != null ? parseInt(String(vmInfo.cpus), 10) : null);
      const memoryMb = cfg.memory != null
        ? parseInt(String(cfg.memory), 10)
        : (vmInfo.maxmem ? Math.round(Number(vmInfo.maxmem) / (1024 * 1024)) : null);
      const diskSizeGb = sumDiskSizeGbFromVmConfig(cfg)
        ?? (vmInfo.maxdisk ? Math.round(Number(vmInfo.maxdisk) / (1024 * 1024 * 1024)) : null);

      return res.json({
        ok: true,
        vm: {
          vmid,
          node: pveNode.name,
          hostname: hostname || null,
          ip,
          cpuCores: Number.isFinite(cpuCores as number) ? cpuCores : null,
          memoryMb: Number.isFinite(memoryMb as number) ? memoryMb : null,
          diskSizeGb: Number.isFinite(diskSizeGb as number) ? diskSizeGb : null,
        },
      });
    } catch {
      continue;
    }
  }

  return res.status(404).json({ error: "VM_NOT_FOUND_ON_PROXMOX" });
});

/**
 * POST /api/admin/vms/manual - 湲곗〈 VM ?占쎈룞 ?占쎈줉 (?占쎌씪 ?占쎈줈??諛⑹떇)
 * Multipart FormData: vmid, hostname, ip?, node?, groupId, privateKey (file), publicKey? (file)
 * ?占쎈줈?占쎈맂 SSH ?占쏙옙? ?占쎌슜?占쎌뿬 Job占?VM???占쎌꽦?占쎈땲??
 */
adminApi.post(
  "/vms/manual",
  upload.fields([
    { name: 'privateKey', maxCount: 1 },
    { name: 'publicKey', maxCount: 1 }
  ]),
  async (req, res) => {
    const { vmid, hostname, ip, node, groupId, cpuCores, memoryMb, diskSizeGb, osType: rawOsType, winUsername, winPassword } = req.body;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const osType = rawOsType === 'windows' ? 'windows' : 'linux';

    // Validate required fields
    if (!vmid || !hostname || !groupId) {
      return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
    }

    // OS-specific validation
    if (osType === 'linux') {
      if (!files || !files.privateKey || files.privateKey.length === 0) {
        return res.status(400).json({ error: "PRIVATE_KEY_FILE_REQUIRED" });
      }
    } else {
      if (!winUsername || !winPassword) {
        return res.status(400).json({ error: "MISSING_WINDOWS_CREDENTIALS" });
      }
    }

    try {
      // Group validation
      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group) {
        return res.status(404).json({ error: "GROUP_NOT_FOUND" });
      }

      // VMID duplicate check
      const existing = await prisma.vm.findFirst({
        where: { vmid: parseInt(String(vmid)) }
      });
      if (existing) {
        return res.status(409).json({ error: "VMID_ALREADY_EXISTS" });
      }

      if (osType === 'linux') {
        // 1. Read uploaded files
        const privateKeyFile = files.privateKey[0];
        const privateKeyContent = privateKeyFile.buffer.toString('utf-8');

        let publicKeyContent: string | undefined;
        if (files.publicKey && files.publicKey.length > 0) {
          publicKeyContent = files.publicKey[0].buffer.toString('utf-8');
        }

        // 2. Process SSH key and generate fingerprint
        const { privateKey, publicKey, fingerprint } = processUploadedSSHKey(
          privateKeyContent,
          publicKeyContent
        );

        const keyVersion = `uploaded-${Date.now()}`;

        // 3. Encrypt private key
        const privateKeyEnc = encryptText(privateKey);

        // 4. Save Key to DB (or reuse existing key if fingerprint exists)
        const existingKey = await prisma.key.findUnique({
          where: { fingerprint }
        });

        if (!existingKey) {
          await prisma.key.create({
            data: {
              fingerprint,
              keyVersion,
              publicKey,
              privateKeyEnc
            }
          });
          console.log(`[Admin] Created new SSH key with fingerprint: ${fingerprint}`);
        } else {
          console.log(`[Admin] Reusing existing SSH key with fingerprint: ${fingerprint}`);
        }

        // 5. Create Job (auto-generated for manual registration)
        const jobId = uuidv4();
        await prisma.job.create({
          data: {
            jobId,
            groupId,
            node: node || "manual",
            template: "manual-registration",
            vmCount: 1,
            storagePool: "manual",
            networkBridge: "manual",
            keyFingerprint: fingerprint
          }
        });

        // 6. Create VM
        const vm = await prisma.vm.create({
          data: {
            vmid: parseInt(String(vmid)),
            hostname,
            ip: ip || null,
            node: node || null,
            groupId,
            jobId,
            osType: 'linux',
            cpuCores: cpuCores ? parseInt(String(cpuCores)) : null,
            memoryMb: memoryMb ? parseInt(String(memoryMb)) : null,
            diskSizeGb: diskSizeGb ? parseInt(String(diskSizeGb)) : null,
          }
        });

        await writeAudit({
          userId: req.user!.id,
          action: "VM_MANUAL_REGISTER",
          result: "SUCCESS",
          vmId: vm.id,
          groupId: groupId,
          jobId: jobId,
          fingerprint: fingerprint,
          reason: `Manually registered existing VM: ${hostname} (VMID: ${vmid}) with uploaded SSH key`,
          requestIp: getClientIp(req),
          userAgent: req.get("user-agent") || ""
        });

        res.json({
          ok: true,
          vm: { id: vm.id, vmid: vm.vmid, hostname: vm.hostname },
          job: { jobId, keyFingerprint: fingerprint }
        });

      } else {
        // Windows VM — no Job, store encrypted credentials
        const winPasswordEnc = encryptText(String(winPassword));

        const vm = await prisma.vm.create({
          data: {
            vmid: parseInt(String(vmid)),
            hostname,
            ip: ip || null,
            node: node || null,
            groupId,
            osType: 'windows',
            winUsername: String(winUsername).trim(),
            winPasswordEnc,
            cpuCores: cpuCores ? parseInt(String(cpuCores)) : null,
            memoryMb: memoryMb ? parseInt(String(memoryMb)) : null,
            diskSizeGb: diskSizeGb ? parseInt(String(diskSizeGb)) : null,
          }
        });

        await writeAudit({
          userId: req.user!.id,
          action: "VM_MANUAL_REGISTER",
          result: "SUCCESS",
          vmId: vm.id,
          groupId: groupId,
          reason: `Manually registered Windows VM: ${hostname} (VMID: ${vmid})`,
          requestIp: getClientIp(req),
          userAgent: req.get("user-agent") || ""
        });

        res.json({
          ok: true,
          vm: { id: vm.id, vmid: vm.vmid, hostname: vm.hostname }
        });
      }
    } catch (e: any) {
      console.error("[Admin] Manual VM registration error:", e);

      await writeAudit({
        userId: req.user!.id,
        action: "VM_MANUAL_REGISTER",
        result: "FAIL",
        reason: e?.message || "INTERNAL_ERROR",
        requestIp: getClientIp(req),
        userAgent: req.get("user-agent") || ""
      });

      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: e?.message || "Failed to register VM"
      });
    }
  }
);

/**
 * POST /api/admin/vms/:id/reveal-credentials - Windows VM 자격증명 조회 (OTP 재인증 필수)
 */
adminApi.post("/vms/:id/reveal-credentials", async (req, res) => {
  try {
    const { otp } = req.body || {};

    if (!req.user?.totpEnabled || !req.user?.totpSecret) {
      return res.status(403).json({ error: "OTP_NOT_ENABLED" });
    }

    if (!otp || String(otp).trim().length < 6) {
      return res.status(400).json({ error: "MISSING_OTP" });
    }

    const valid = verifyTotp(req.user as any, String(otp).trim());
    if (!valid) {
      return res.status(401).json({ error: "INVALID_OTP" });
    }

    const vm = await prisma.vm.findUnique({ where: { id: req.params.id } });
    if (!vm) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    if (vm.osType !== 'windows' || !vm.winPasswordEnc) {
      return res.status(400).json({ error: "NO_WINDOWS_CREDENTIALS" });
    }

    await writeAudit({
      userId: req.user!.id,
      action: "VM_CREDENTIALS_REVEAL",
      result: "SUCCESS",
      vmId: vm.id,
      groupId: vm.groupId,
      reason: `Revealed Windows credentials for VM: ${vm.hostname || vm.vmid}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({
      ok: true,
      username: vm.winUsername,
      password: decryptText(vm.winPasswordEnc)
    });
  } catch (e: any) {
    console.error("[Admin] Reveal credentials error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * DELETE /api/admin/vms/:id - VM ??占쏙옙 (Soft Delete)
 */
adminApi.delete("/vms/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const vm = await prisma.vm.findUnique({
      where: { id },
      include: {
        group: { select: { name: true } }
      }
    });

    if (!vm) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    if (vm.deletedAt) {
      return res.status(400).json({ error: "VM_ALREADY_DELETED" });
    }

    // Soft delete
    await prisma.vm.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedBy: req.user!.id
      }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_DELETE",
      result: "SUCCESS",
      vmId: id,
      groupId: vm.groupId,
      reason: `Deleted VM ${vm.hostname || vm.vmid}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
      vmHostname: vm.hostname || `VM-${vm.vmid}`,
      vmid: vm.vmid || 0,
      groupName: vm.group.name,
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] VM deletion error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /api/admin/vms/:id/restore - ??占쏙옙??VM 蹂듦뎄
 */
adminApi.post("/vms/:id/restore", async (req, res) => {
  const { id } = req.params;

  try {
    const vm = await prisma.vm.findUnique({
      where: { id }
    });

    if (!vm) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    if (!vm.deletedAt) {
      return res.status(400).json({ error: "VM_NOT_DELETED" });
    }

    // 蹂듦뎄
    await prisma.vm.update({
      where: { id },
      data: {
        deletedAt: null,
        deletedBy: null
      }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_RESTORE",
      result: "SUCCESS",
      vmId: id,
      reason: `Restored VM ${vm.hostname || vm.vmid}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] VM restore error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * DELETE /api/admin/vms/:id/permanent - VM ?占쎄뎄 ??占쏙옙 (Hard Delete + Proxmox ??占쏙옙)
 * ??占쏙옙??VM占??占쎄뎄 ??占쏙옙 媛?? * Proxmox?占쎌꽌??VM???占쎌쟾???占쎄굅?占쎈땲??
 */
adminApi.delete("/vms/:id/permanent", async (req, res) => {
  const { id } = req.params;
  const dbOnly = req.query.dbOnly === 'true';

  try {
    const vm = await prisma.vm.findUnique({
      where: { id },
      include: {
        group: { select: { name: true } }
      }
    });

    if (!vm) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    // ?占쏀봽????占쏙옙?占쏙옙? ?占쏙옙? VM?占??占쎄뎄 ??占쏙옙 遺덌옙?
    if (!vm.deletedAt) {
      return res.status(400).json({ error: "VM_MUST_BE_SOFT_DELETED_FIRST" });
    }

    // Proxmox?占쎌꽌 VM ??占쏙옙 ?占쎈룄 (dbOnly=true 이면 스킵)
    let proxmoxDeleted = false;
    if (!dbOnly && vm.node && vm.vmid) {
      try {
        const pveNode = await prisma.pveNode.findFirst({
          where: { name: vm.node, isOnline: true },
        });
        if (pveNode) {
          const { ProxmoxClient } = await import("../../services/proxmox");
          const { decryptText } = await import("../../services/crypto");
          const client = new ProxmoxClient(
            pveNode.host,
            pveNode.tokenId,
            decryptText(pveNode.tokenSecret)
          );

          // Proxmox 이름 \uac80증 - DB 호스트명과 Proxmox config.name 비\uad50
          const force = req.query.force === 'true';
          const cfgCheck = await client.getVmConfig(vm.node, vm.vmid);
          if (cfgCheck.ok && cfgCheck.data?.name && vm.hostname && cfgCheck.data.name !== vm.hostname && !force) {
            return res.status(409).json({
              error: 'VM_NAME_MISMATCH',
              dbName: vm.hostname,
              proxmoxName: cfgCheck.data.name,
              message: `Proxmox VM name "${cfgCheck.data.name}" does not match DB hostname "${vm.hostname}". Pass force=true to override.`
            });
          }

          // VM 以묕옙? ????占쏙옙
          await client.stopVm(vm.node, vm.vmid);
          await new Promise((r) => setTimeout(r, 3000));

          const delResult = await client.deleteVm(vm.node, vm.vmid, true);
          if (delResult.ok) {
            proxmoxDeleted = true;
            // Wait for delete task completion
            if (delResult.data) {
              await client.waitForTask(vm.node, delResult.data, 120000);
            }
          }
        }
      } catch (pveErr: any) {
        console.warn(`[Admin] Proxmox VM ??占쏙옙 ?占쏀뙣 (VMID: ${vm.vmid}): ${pveErr.message}`);
        // Proxmox ??占쏙옙 ?占쏀뙣?占쎈룄 DB ??占쏙옙??吏꾪뻾
      }
    }

    // DB?占쎌꽌 ?占쎄뎄 ??占쏙옙
    await prisma.vm.delete({
      where: { id }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_PERMANENT_DELETE",
      result: "SUCCESS",
      vmId: id,
      groupId: vm.groupId,
      reason: `Permanently deleted VM ${vm.hostname || vm.vmid} (Proxmox: ${proxmoxDeleted ? 'deleted' : 'skipped'})`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true, proxmoxDeleted });
  } catch (e: any) {
    console.error("[Admin] VM permanent deletion error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

type NotificationEventKey = typeof NOTIFICATION_EVENT_KEYS[number];
const DEFAULT_NOTIFICATION_EVENTS: NotificationEventKey[] = [
  "login_success",
  "login_fail",
  "otp_setup_completed",
  "otp_recovery_used",
  "password_changed",
  "password_reset_request",
  "vm_request_create",
  "vm_request_approve",
  "vm_request_reject",
  "deploy_completed",
  "vm_delete",
  "vm_permanent_delete",
  "key_download",
  "user_create",
  "user_activate",
  "user_deactivate",
  "user_delete",
  "user_reset_password",
  "user_reset_otp",
];

function sanitizeNotificationEvents(raw: any): NotificationEventKey[] {
  if (!Array.isArray(raw)) return [...DEFAULT_NOTIFICATION_EVENTS];
  const filtered = raw
    .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
    .filter((v): v is NotificationEventKey =>
      (NOTIFICATION_EVENT_KEYS as readonly string[]).includes(v)
    );
  return Array.from(new Set(filtered));
}

/**
 * GET /api/admin/notifications - ?占쎈┝ ?占쎌젙 議고쉶
 */
adminApi.get("/notifications", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "notification_config" }
    });

    if (!config) {
      // 湲곕낯 ?占쎌젙 諛섑솚
	      return res.json({
	        ok: true,
	        config: {
	          slack: {
	            enabled: false,
	            webhookUrl: "",
	            events: [...DEFAULT_NOTIFICATION_EVENTS]
	          },
	          teams: {
	            enabled: false,
	            webhookUrl: "",
	            events: [...DEFAULT_NOTIFICATION_EVENTS]
	          },
	          email: {
	            enabled: false,
	            provider: "custom",
	            smtpHost: "",
	            smtpPort: 587,
	            smtpUser: "",
	            smtpPassword: "",
	            from: "",
	            to: [],
	            events: [...DEFAULT_NOTIFICATION_EVENTS]
	          },
	          webhook: {
	            enabled: false,
	            url: "",
	            headers: {},
	            events: [...DEFAULT_NOTIFICATION_EVENTS]
	          }
	        }
	      });
		    }
		
		    const parsedConfig = JSON.parse(config.value || "{}");
		    const mergedConfig = {
		      slack: {
		        enabled: !!parsedConfig?.slack?.enabled,
		        webhookUrl: typeof parsedConfig?.slack?.webhookUrl === "string" ? parsedConfig.slack.webhookUrl : "",
		        events: sanitizeNotificationEvents(parsedConfig?.slack?.events)
		      },
		      teams: {
		        enabled: !!parsedConfig?.teams?.enabled,
		        webhookUrl: typeof parsedConfig?.teams?.webhookUrl === "string" ? parsedConfig.teams.webhookUrl : "",
		        events: sanitizeNotificationEvents(parsedConfig?.teams?.events)
		      },
		      email: {
		        enabled: !!parsedConfig?.email?.enabled,
		        provider: (["gmail","naver","daum","kakao","custom"].includes(parsedConfig?.email?.provider) ? parsedConfig.email.provider : "custom") as EmailProvider,
		        smtpHost: typeof parsedConfig?.email?.smtpHost === "string" ? parsedConfig.email.smtpHost : "",
		        smtpPort: Number.isFinite(Number(parsedConfig?.email?.smtpPort)) ? Number(parsedConfig.email.smtpPort) : 587,
	        smtpUser: typeof parsedConfig?.email?.smtpUser === "string" ? parsedConfig.email.smtpUser : "",
	        smtpPassword: typeof parsedConfig?.email?.smtpPassword === "string" ? parsedConfig.email.smtpPassword : "",
	        from: typeof parsedConfig?.email?.from === "string" ? parsedConfig.email.from : "",
	        to: Array.isArray(parsedConfig?.email?.to) ? parsedConfig.email.to : [],
	        events: sanitizeNotificationEvents(parsedConfig?.email?.events)
	      },
	      webhook: {
	        enabled: !!parsedConfig?.webhook?.enabled,
	        url: typeof parsedConfig?.webhook?.url === "string" ? parsedConfig.webhook.url : "",
	        headers: parsedConfig?.webhook?.headers && typeof parsedConfig.webhook.headers === "object" ? parsedConfig.webhook.headers : {},
	        events: sanitizeNotificationEvents(parsedConfig?.webhook?.events)
	      }
	    };
    res.json({ ok: true, config: mergedConfig });
  } catch (e: any) {
    console.error("[Admin] Notification config query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

	/**
	 * PATCH /api/admin/notifications - ?占쎈┝ ?占쎌젙 ?占쎈뜲?占쏀듃
	 * Body: { slack?, teams?, email?, webhook? }
	 */
	adminApi.patch("/notifications", async (req, res) => {
	  const { slack, teams, email, webhook } = req.body;
	
	  try {
	    // ?占쎌옱 ?占쎌젙 媛?占쎌삤占?(?占쎌쑝占?湲곕낯占?
	    const existing = await prisma.systemConfig.findUnique({
	      where: { key: "notification_config" }
	    });

	    const parsedCurrent = existing ? JSON.parse(existing.value) : {};
	    const currentConfig = {
	      slack: parsedCurrent.slack || { enabled: false, webhookUrl: "", events: [...DEFAULT_NOTIFICATION_EVENTS] },
	      teams: parsedCurrent.teams || { enabled: false, webhookUrl: "", events: [...DEFAULT_NOTIFICATION_EVENTS] },
	      email: { enabled: false, provider: "custom" as EmailProvider, smtpHost: "", smtpPort: 587, smtpUser: "", smtpPassword: "", from: "", to: [], events: [...DEFAULT_NOTIFICATION_EVENTS] },
	      webhook: { enabled: false, url: "", headers: {}, events: [...DEFAULT_NOTIFICATION_EVENTS] }
	    };

	    // Merge incoming partial config
	    const mergedConfig = {
	      slack: slack ? { ...currentConfig.slack, ...slack } : currentConfig.slack,
	      teams: teams ? { ...currentConfig.teams, ...teams } : currentConfig.teams,
	      email: email ? { ...currentConfig.email, ...email } : currentConfig.email,
	      webhook: webhook ? { ...currentConfig.webhook, ...webhook } : currentConfig.webhook
	    };

    const toTrimmedString = (v: any) => (typeof v === "string" ? v.trim() : "");

	    const normalizedConfig = {
	      slack: {
	        enabled: !!mergedConfig.slack?.enabled,
	        webhookUrl: toTrimmedString(mergedConfig.slack?.webhookUrl),
	        events: sanitizeNotificationEvents(mergedConfig.slack?.events)
	      },
	      teams: {
	        enabled: !!mergedConfig.teams?.enabled,
	        webhookUrl: toTrimmedString(mergedConfig.teams?.webhookUrl),
	        events: sanitizeNotificationEvents(mergedConfig.teams?.events)
	      },
	      email: {
	        enabled: !!mergedConfig.email?.enabled,
	        provider: (["gmail","naver","daum","kakao","custom"].includes(mergedConfig.email?.provider) ? mergedConfig.email.provider : "custom") as EmailProvider,
	        smtpHost: toTrimmedString(mergedConfig.email?.smtpHost),
	        smtpPort: Number.isFinite(Number(mergedConfig.email?.smtpPort)) ? Number(mergedConfig.email?.smtpPort) : 587,
	        smtpUser: toTrimmedString(mergedConfig.email?.smtpUser),
	        smtpPassword: typeof mergedConfig.email?.smtpPassword === "string" ? mergedConfig.email.smtpPassword : "",
	        from: toTrimmedString(mergedConfig.email?.from),
	        to: Array.isArray(mergedConfig.email?.to)
	          ? mergedConfig.email.to.map((t: string) => String(t).trim()).filter(Boolean)
	          : [],
	        events: sanitizeNotificationEvents(mergedConfig.email?.events)
	      },
	      webhook: {
	        enabled: !!mergedConfig.webhook?.enabled,
	        url: toTrimmedString(mergedConfig.webhook?.url),
	        headers: mergedConfig.webhook?.headers && typeof mergedConfig.webhook.headers === "object" ? mergedConfig.webhook.headers : {},
	        events: sanitizeNotificationEvents(mergedConfig.webhook?.events)
	      }
	    };

    if (normalizedConfig.slack.enabled) {
      if (!normalizedConfig.slack.webhookUrl) {
        return res.status(400).json({ error: "SLACK_WEBHOOK_REQUIRED" });
      }
      if (!isValidHttpUrl(normalizedConfig.slack.webhookUrl)) {
        return res.status(400).json({ error: "SLACK_WEBHOOK_INVALID" });
      }
    }

    if (normalizedConfig.teams.enabled) {
      if (!normalizedConfig.teams.webhookUrl) {
        return res.status(400).json({ error: "TEAMS_WEBHOOK_REQUIRED" });
      }
      if (!isValidHttpUrl(normalizedConfig.teams.webhookUrl)) {
        return res.status(400).json({ error: "TEAMS_WEBHOOK_INVALID" });
      }
    }

    if (normalizedConfig.email.enabled) {
      const emailProvider = normalizedConfig.email.provider ?? "custom";
      const needsCustomHost = emailProvider === "custom";
      if (
        (needsCustomHost && !normalizedConfig.email.smtpHost) ||
        !normalizedConfig.email.smtpUser ||
        !normalizedConfig.email.smtpPassword ||
        !normalizedConfig.email.from ||
        normalizedConfig.email.to.length === 0
      ) {
        return res.status(400).json({ error: "EMAIL_CONFIG_REQUIRED_FIELDS" });
      }
    }

    if (normalizedConfig.webhook.enabled) {
      if (!normalizedConfig.webhook.url) {
        return res.status(400).json({ error: "WEBHOOK_URL_REQUIRED" });
      }
      if (!isValidHttpUrl(normalizedConfig.webhook.url)) {
        return res.status(400).json({ error: "WEBHOOK_URL_INVALID" });
      }
    }

    // Persist notification config
    await prisma.systemConfig.upsert({
      where: { key: "notification_config" },
      create: {
        key: "notification_config",
        value: JSON.stringify(normalizedConfig)
      },
      update: {
        value: JSON.stringify(normalizedConfig)
      }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "NOTIFICATION_CONFIG_UPDATE",
      result: "SUCCESS",
      reason: "Updated notification configuration",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true, config: normalizedConfig });
  } catch (e: any) {
    console.error("[Admin] Notification config update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /api/admin/notifications/test - 채널별 알림 테스트 전송
 * Body: { channel: "slack" | "teams" | "email" | "webhook", config: object }
 */
	adminApi.post("/notifications/test", async (req, res) => {
	  const channel = typeof req.body?.channel === "string" ? req.body.channel.trim().toLowerCase() : "";
	  const cfg = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
	  const actor = req.user?.email || "admin";
	  const timestamp = new Date().toISOString();
	
	  try {
	    if (!channel || !["slack", "teams", "email", "webhook"].includes(channel)) {
	      return res.status(400).json({ error: "INVALID_NOTIFICATION_CHANNEL" });
	    }
	
	    if (channel === "email") {
	      const provider = (["gmail","naver","daum","kakao","custom"].includes(cfg.provider) ? cfg.provider : "custom") as EmailProvider;
	      const preset = provider !== "custom" ? SMTP_PRESETS[provider] : null;
	      const smtpHost = preset ? preset.host : (typeof cfg.smtpHost === "string" ? cfg.smtpHost.trim() : "");
	      const smtpPort = preset ? preset.port : (Number.isFinite(Number(cfg.smtpPort)) ? Number(cfg.smtpPort) : 587);
	      const smtpUser = typeof cfg.smtpUser === "string" ? cfg.smtpUser.trim() : "";
	      const smtpPassword = typeof cfg.smtpPassword === "string" ? cfg.smtpPassword : "";
	      const from = typeof cfg.from === "string" ? cfg.from.trim() : "";
	      const toArray: string[] = Array.isArray(cfg.to)
	        ? cfg.to.map((t: string) => String(t).trim()).filter(Boolean)
	        : (typeof cfg.to === "string" ? cfg.to.split(",").map((t: string) => t.trim()).filter(Boolean) : []);

	      if (!smtpHost || !smtpUser || !smtpPassword || !from || toArray.length === 0) {
	        return res.status(400).json({ error: "EMAIL_CONFIG_REQUIRED_FIELDS" });
	      }

	      await sendTestEmail({ provider, smtpHost, smtpPort, smtpUser, smtpPassword, fromEmail: from, to: toArray });
	    }

	    if (channel === "slack") {
	      const webhookUrl = typeof cfg.webhookUrl === "string" ? cfg.webhookUrl.trim() : "";
	      if (!webhookUrl) {
	        return res.status(400).json({ error: "SLACK_WEBHOOK_REQUIRED" });
	      }
      if (!isValidHttpUrl(webhookUrl)) {
        return res.status(400).json({ error: "SLACK_WEBHOOK_INVALID" });
      }

      await postJsonWebhook(webhookUrl, {
        text: "Proxmox 테스트 알림",
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "Proxmox Test Notification", emoji: true },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Channel:*\nSlack` },
              { type: "mrkdwn", text: `*By:*\n${actor}` },
              { type: "mrkdwn", text: `*Time:*\n${timestamp}` },
            ],
          },
        ],
	      });
	    }
	
	    if (channel === "teams") {
	      const webhookUrl = typeof cfg.webhookUrl === "string" ? cfg.webhookUrl.trim() : "";
	      if (!webhookUrl) {
	        return res.status(400).json({ error: "TEAMS_WEBHOOK_REQUIRED" });
	      }
      if (!isValidHttpUrl(webhookUrl)) {
        return res.status(400).json({ error: "TEAMS_WEBHOOK_INVALID" });
      }

      await postJsonWebhook(webhookUrl, {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        summary: "Proxmox Test Notification",
        themeColor: "0078D4",
        title: "Proxmox Test Notification",
        sections: [
          {
            facts: [
              { name: "Channel", value: "Teams" },
              { name: "By", value: actor },
              { name: "Time", value: timestamp },
            ],
          },
        ],
	      });
	    }
	
	    if (channel === "webhook") {
	      const webhookUrl = typeof cfg.url === "string" ? cfg.url.trim() : "";
	      const headers = normalizeNotificationHeaders(cfg.headers);
	      if (!webhookUrl) {
	        return res.status(400).json({ error: "WEBHOOK_URL_REQUIRED" });
      }
      if (!isValidHttpUrl(webhookUrl)) {
        return res.status(400).json({ error: "WEBHOOK_URL_INVALID" });
      }

      await postJsonWebhook(
        webhookUrl,
        {
          event: "notification_test",
          channel: "webhook",
          actor,
          timestamp,
          message: "Proxmox test notification",
        },
        headers
      );
    }

	    await writeAudit({
	      userId: req.user!.id,
	      action: "NOTIFICATION_TEST",
	      result: "SUCCESS",
	      reason: `Notification test sent (${channel})`,
	      requestIp: getClientIp(req),
	      userAgent: req.get("user-agent") || "",
	    });
	
	    return res.json({ ok: true, channel });
	  } catch (e: any) {
	    console.error(`[Admin] Notification test error (${channel}):`, e);
	    return res.status(500).json({ error: e?.message || "NOTIFICATION_TEST_FAILED" });
	  }
	});

/**
 * GET /api/admin/export/users - Export users to CSV
 */
adminApi.get("/export/users", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        memberships: {
          include: { group: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const csvRows = [
      'Email,Status,Admin,OTP Enabled,Groups,Created Date,Last Password Change'
    ];

    users.forEach(user => {
      const groups = user.memberships.map(m => m.group.name).join('; ');
      const status = user.isActive ? 'Active' : 'Inactive';
      const isAdmin = user.isAdmin ? 'Yes' : 'No';
      const otpEnabled = user.totpEnabled ? 'Yes' : 'No';
      const createdDate = user.createdAt ? new Date(user.createdAt).toISOString().split('T')[0] : '';
      const lastPwChange = user.passwordLastChanged ? new Date(user.passwordLastChanged).toISOString().split('T')[0] : '';

      csvRows.push([csvEscape(user.email), status, isAdmin, otpEnabled, csvEscape(groups), createdDate, lastPwChange].join(','));
    });

    const csv = csvRows.join('\n');
    const timestamp = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="users_${timestamp}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8 support
  } catch (e: any) {
    console.error("[Admin] Users CSV export error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/export/vms - Export VMs to CSV
 */
adminApi.get("/export/vms", async (req, res) => {
  try {
    const vms = await prisma.vm.findMany({
      where: { deletedAt: null },
      include: {
        group: true,
        job: {
          include: {
            key: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const csvRows = [
      'VMID,Hostname,IP Address,Node,Group,Job ID,SSH Key Status,CPU Cores,Memory(MB),Disk(GB),Created Date'
    ];

    vms.forEach(vm => {
      const jobId = vm.jobId ? vm.jobId.substring(0, 8) : '';
      const keyStatus = vm.job?.key ? 'Available' : 'None';
      const createdDate = vm.createdAt ? new Date(vm.createdAt).toISOString().split('T')[0] : '';

      csvRows.push([
        vm.vmid ?? '',
        csvEscape(vm.hostname),
        csvEscape(vm.ip),
        csvEscape(vm.node),
        csvEscape(vm.group.name),
        csvEscape(jobId),
        keyStatus,
        vm.cpuCores ?? '',
        vm.memoryMb ?? '',
        vm.diskSizeGb ?? '',
        createdDate,
      ].join(','));
    });

    const csv = csvRows.join('\n');
    const timestamp = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vms_${timestamp}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (e: any) {
    console.error("[Admin] VMs CSV export error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/export/audit-logs - Export audit logs to CSV
 */
adminApi.get("/export/audit-logs", async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      include: {
        user: true
      },
      orderBy: { createdAt: 'desc' },
      take: 10000 // Limit to last 10,000 entries
    });

    const csvRows = [
      'Timestamp,User Email,Action,Result,IP Address,User Agent,Details'
    ];

    logs.forEach(log => {
      const timestamp = new Date(log.createdAt).toISOString().replace('T', ' ').split('.')[0];
      const userEmail = log.user?.email || 'System';

      csvRows.push([
        csvEscape(timestamp),
        csvEscape(userEmail),
        csvEscape(log.action),
        csvEscape(log.result),
        csvEscape(log.requestIp),
        csvEscape(log.userAgent),
        csvEscape(log.reason),
      ].join(','));
    });

    const csv = csvRows.join('\n');
    const timestamp = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${timestamp}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (e: any) {
    console.error("[Admin] Audit logs CSV export error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/export/groups - Export groups to CSV
 */
adminApi.get("/export/groups", async (req, res) => {
  try {
    const groups = await prisma.group.findMany({
      include: {
        members: true,
        vms: {
          where: { deletedAt: null }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const csvRows = [
      'Group Name,Member Count,VM Count,Created Date'
    ];

    groups.forEach(group => {
      const createdDate = group.createdAt ? new Date(group.createdAt).toISOString().split('T')[0] : '';
      csvRows.push([csvEscape(group.name), group.members.length, group.vms.length, createdDate].join(','));
    });

    const csv = csvRows.join('\n');
    const timestamp = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="groups_${timestamp}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (e: any) {
    console.error("[Admin] Groups CSV export error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * Note: getDefaultMenuConfig() is now imported from utils/defaultMenuConfig.ts
 * The default menu configuration is loaded from app/defaults/default-menu-config.json
 * This eliminates hardcoded menu values and makes the config file the single source of truth.
 */

/**
 * GET /api/admin/menu-config - 硫붾돱 ?占쎌젙 議고쉶
 */
adminApi.get("/menu-config", async (req, res) => {
  console.log("[Admin API] GET /menu-config called by user:", req.user?.email);
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "menu_config" }
    });

    if (!config) {
      // 湲곕낯 硫붾돱 ?占쎌젙 諛섑솚 (UUID 援ъ“)
      const defaultConfig = getDefaultMenuConfig();
      return res.json({
        ok: true,
        config: defaultConfig
      });
    }

    res.json({ ok: true, config: JSON.parse(config.value) });
  } catch (e: any) {
    console.error("[Admin] Menu config query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/menu-config - 硫붾돱 ?占쎌젙 ?占쎈뜲?占쏀듃
 * Body: { header_menus, admin_tabs, sidebar_menus }
 */
adminApi.patch("/menu-config", async (req, res) => {
  const { header_menus, admin_tabs, sidebar_menus } = req.body;

  if (!header_menus || !Array.isArray(header_menus)) {
    return res.status(400).json({ error: "INVALID_MENU_CONFIG" });
  }

  try {
    const newConfig = {
      header_menus,
      admin_tabs: admin_tabs || [],
      sidebar_menus: sidebar_menus || []
    };

    await prisma.systemConfig.upsert({
      where: { key: "menu_config" },
      create: {
        key: "menu_config",
        value: JSON.stringify(newConfig)
      },
      update: {
        value: JSON.stringify(newConfig)
      }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "MENU_CONFIG_UPDATE",
      result: "SUCCESS",
      reason: `Updated menu configuration: ${header_menus.length} header menus, ${(admin_tabs || []).length} admin tabs`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true, config: newConfig });
  } catch (e: any) {
    console.error("[Admin] Menu config update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/section-labels - ?占쎌뀡 ?占쎈ぉ ?占쎌젙 議고쉶
 */
adminApi.get("/section-labels", async (req, res) => {
  console.log("[Admin API] GET /section-labels called by user:", req.user?.email);
  try {
    // DB??而ㅼ뒪?占??占쎌뀡 ?占쎈꺼???占쎌쑝占?洹몌옙?占?諛섑솚
    const config = await prisma.systemConfig.findUnique({
      where: { key: "section_labels" }
    });

    if (config) {
      return res.json({ ok: true, labels: JSON.parse(config.value) });
    }

    // label system?占쎌꽌 ?占쎌뀡 ?占쎈낫 異붿텧 (title, icon, description占?
    const cookieLang = req.cookies?.preferred_lang;
    const lang: SupportedLanguage = (cookieLang && ['ko', 'en'].includes(cookieLang)) ? cookieLang : 'ko';
    const fullLabels = toLegacyFormat(lang);

    const sections: any = {};
    for (const [page, pageSections] of Object.entries(fullLabels)) {
      if (page === 'labels') continue;
      sections[page] = {};
      for (const [key, val] of Object.entries(pageSections as any)) {
        sections[page][key] = {
          title: (val as any).title,
          icon: (val as any).icon,
          description: (val as any).description
        };
      }
    }

    res.json({ ok: true, labels: sections });
  } catch (e: any) {
    console.error("[Admin] Section labels query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/section-labels - ?占쎌뀡 ?占쎈ぉ ?占쎌젙 ?占쎈뜲?占쏀듃
 * Body: { labels }
 */
adminApi.patch("/section-labels", async (req, res) => {
  const { labels } = req.body;

  if (!labels || typeof labels !== 'object') {
    return res.status(400).json({ error: "INVALID_LABELS_CONFIG" });
  }

  try {
    await prisma.systemConfig.upsert({
      where: { key: "section_labels" },
      create: {
        key: "section_labels",
        value: JSON.stringify(labels)
      },
      update: {
        value: JSON.stringify(labels)
      }
    });

    await writeAudit({
      userId: req.user!.id,
      action: "SECTION_LABELS_UPDATE",
      result: "SUCCESS",
      reason: "Updated section labels configuration",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true, labels });
  } catch (e: any) {
    console.error("[Admin] Section labels update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/ui-elements - UI ?占쎌냼 ?占쎌젙 議고쉶
 */
adminApi.get("/ui-elements", async (req, res) => {
  try {
    // DB??而ㅼ뒪?占??占쎌젙???占쎌쑝占?諛섑솚
    const config = await prisma.systemConfig.findUnique({
      where: { key: "ui_elements" }
    });
    if (config) {
      return res.json({ ok: true, data: JSON.parse(config.value) });
    }
    // ?占쎌씪?占쎌꽌 湲곕낯占?濡쒕뱶
    const elements = loadUIElements();
    res.json({ ok: true, data: elements });
  } catch (e: any) {
    console.error("[Admin] UI elements query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/ui-elements - UI ?占쎌냼 ?占쎌젙 ?占쎈뜲?占쏀듃
 */
adminApi.patch("/ui-elements", async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: "INVALID_UI_ELEMENTS" });
  }
  try {
    await prisma.systemConfig.upsert({
      where: { key: "ui_elements" },
      create: { key: "ui_elements", value: JSON.stringify(data) },
      update: { value: JSON.stringify(data) }
    });
    await writeAudit({
      userId: req.user!.id,
      action: "UI_ELEMENTS_UPDATE",
      result: "SUCCESS",
      reason: "Updated UI elements configuration",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] UI elements update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/labels/:lang - ?占쎌뼱占??占쎈꺼 議고쉶
 */
adminApi.get("/labels/:lang", async (req, res) => {
  const lang = req.params.lang as SupportedLanguage;
  if (!['ko', 'en'].includes(lang)) {
    return res.status(400).json({ error: "INVALID_LANGUAGE" });
  }
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: `labels_${lang}` }
    });
    if (config) {
      return res.json({ ok: true, data: JSON.parse(config.value) });
    }
    const labels = loadLabels(lang);
    res.json({ ok: true, data: labels });
  } catch (e: any) {
    console.error(`[Admin] Labels (${lang}) query error:`, e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/labels/:lang - ?占쎌뼱占??占쎈꺼 ?占쎈뜲?占쏀듃
 */
adminApi.patch("/labels/:lang", async (req, res) => {
  const lang = req.params.lang as SupportedLanguage;
  if (!['ko', 'en'].includes(lang)) {
    return res.status(400).json({ error: "INVALID_LANGUAGE" });
  }
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: "INVALID_LABELS_DATA" });
  }
  try {
    await prisma.systemConfig.upsert({
      where: { key: `labels_${lang}` },
      create: { key: `labels_${lang}`, value: JSON.stringify(data) },
      update: { value: JSON.stringify(data) }
    });
    await writeAudit({
      userId: req.user!.id,
      action: "LABELS_UPDATE",
      result: "SUCCESS",
      reason: `Updated ${lang} labels`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error(`[Admin] Labels (${lang}) update error:`, e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/ui-strings - UI ?占쎌뒪???占쎌젙 議고쉶
 * 湲곕낯占?+ DB ?占쎈쾭?占쎌씠?占쏙옙? 蹂묓빀?占쎌뿬 諛섑솚
 */
adminApi.get("/ui-strings", async (req, res) => {
  try {
    const strings = await getUIStrings(prisma);
    res.json({ ok: true, strings });
  } catch (e: any) {
    console.error("[Admin] UI strings query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/ui-strings/defaults - UI ?占쎌뒪??湲곕낯占?議고쉶 (?占쎈쾭?占쎌씠???占쎌쇅)
 * 由ъ뀑 誘몃━蹂닿린 ?占쎈뒗 李멸퀬?? */
adminApi.get("/ui-strings/defaults", async (req, res) => {
  try {
    const defaults = getDefaultUIStrings();
    res.json({ ok: true, defaults });
  } catch (e: any) {
    console.error("[Admin] UI strings defaults query error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/ui-strings - UI ?占쎌뒪???占쎈쾭?占쎌씠???占쎈뜲?占쏀듃
 * Body: Partial<UIStrings> - 蹂寃쏀븷 ??占쏙옙占??占쏀븿
 */
adminApi.patch("/ui-strings", async (req, res) => {
  const { overrides } = req.body;

  if (!overrides || typeof overrides !== 'object') {
    return res.status(400).json({ error: "INVALID_OVERRIDES" });
  }

  try {
    await saveUIStringOverrides(prisma, overrides);

    await writeAudit({
      userId: req.user!.id,
      action: "UI_STRINGS_UPDATE",
      result: "SUCCESS",
      reason: "Updated UI strings configuration",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] UI strings update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * DELETE /api/admin/ui-strings - UI ?占쎌뒪??珥덇린??(湲곕낯媛믪쑝占?由ъ뀑)
 * DB???占쎈쾭?占쎌씠?占쏙옙? ??占쏙옙?占쎌뿬 湲곕낯媛믪쑝占?蹂듭썝
 */
adminApi.delete("/ui-strings", async (req, res) => {
  try {
    await resetUIStrings(prisma);

    await writeAudit({
      userId: req.user!.id,
      action: "UI_STRINGS_RESET",
      result: "SUCCESS",
      reason: "Reset UI strings to defaults",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] UI strings reset error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧??//  VM ?占쎌꽦 ?占쎌껌 愿占?// ?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧??
/**
 * GET /api/admin/vm-requests - ?占쎌껜 VM ?占쎌껌 紐⑸줉
 */
adminApi.get("/vm-requests", async (req, res) => {
  try {
    const requests = await prisma.vmRequest.findMany({
      include: {
        group: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // ?占쎌껌???占쎈찓??議고쉶
    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true },
    });
    const userMap = Object.fromEntries(users.map((u) => [u.id, u.email]));

    const enriched = requests.map((r) => ({
      ...r,
      requestedByEmail: userMap[r.requestedBy] || r.requestedBy,
    }));

    res.json({ ok: true, requests: enriched });
  } catch (e: any) {
    console.error("[Admin] VM requests list error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/admin/vm-requests/:id/deploy-log - 요청별 배포 로그/결과 조회
 */
adminApi.get("/vm-requests/:id/deploy-log", async (req, res) => {
  const { id } = req.params;

  try {
    const request = await prisma.vmRequest.findUnique({
      where: { id },
      include: {
        group: { select: { id: true, name: true } },
      },
    });
    if (!request) return res.status(404).json({ error: "REQUEST_NOT_FOUND" });

    let task: any = null;
    let vms: any[] = [];
    if (request.deployTaskId) {
      task = await prisma.deployTask.findUnique({
        where: { id: request.deployTaskId },
        select: {
          id: true,
          jobId: true,
          status: true,
          currentStep: true,
          progress: true,
          completedVms: true,
          failedVms: true,
          vmCount: true,
          errorLog: true,
          node: true,
          storagePool: true,
          networkBridge: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (task?.jobId) {
        vms = await prisma.vm.findMany({
          where: { jobId: task.jobId },
          orderBy: [{ vmid: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            vmid: true,
            hostname: true,
            ip: true,
            node: true,
            status: true,
            createdAt: true,
            deletedAt: true,
          },
        });
      }
    }

    res.json({
      ok: true,
      request: {
        id: request.id,
        status: request.status,
        instanceType: request.instanceType,
        vmCount: request.vmCount,
        hostnamePrefix: request.hostnamePrefix,
        purpose: request.purpose,
        createdAt: request.createdAt,
        reviewedAt: request.reviewedAt,
        group: request.group,
        deployTaskId: request.deployTaskId,
      },
      task,
      vms,
    });
  } catch (e: any) {
    console.error("[Admin] VM request deploy-log error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/vm-requests/:id/approve - ?占쎌껌 ?占쎌씤 + ?占쏀봽???占쎈낫 ?占쎈젰
 */
adminApi.patch("/vm-requests/:id/approve", async (req, res) => {
  const { id } = req.params;
  const {
    nodeId, node, vmSource, sourceTemplateVmid,
    cloudImageVolid,
    startVmid, startNumber, startIp, gatewayIp, dnsPrimary, dnsSecondary,
    storagePool, networkBridge, sshPort, vmUser, fsType,
    reviewNote,
  } = req.body;

  // Required infrastructure fields
  if (!nodeId || !startIp || !gatewayIp || !storagePool || !networkBridge) {
    return res.status(400).json({ error: "MISSING_INFRA_FIELDS" });
  }
  if (vmSource === "cloud-image" && !cloudImageVolid) {
    return res.status(400).json({
      error: "MISSING_CLOUD_IMAGE",
      message: "Cloud Image 선택은 필수입니다. import 콘텐츠 이미지를 선택하세요.",
    });
  }
  if (
    vmSource === "cloud-image" &&
    cloudImageVolid &&
    !String(cloudImageVolid).includes(":") &&
    !String(cloudImageVolid).startsWith("import/")
  ) {
    return res.status(400).json({
      error: "INVALID_CLOUD_IMAGE_SOURCE",
      message: "Cloud Image 형식이 올바르지 않습니다. 'storage:import/<file>' 형식을 사용하세요.",
    });
  }
  if (vmSource === "cloud-image" && cloudImageVolid && String(cloudImageVolid).includes(":iso/")) {
    return res.status(400).json({
      error: "INVALID_CLOUD_IMAGE_SOURCE",
      message: "import-from에는 iso 콘텐츠를 사용할 수 없습니다. import 콘텐츠(local:import/...)를 선택하세요.",
    });
  }

  try {
    const request = await prisma.vmRequest.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: "REQUEST_NOT_FOUND" });

    if (request.status !== "REQUESTED") {
      return res.status(400).json({ error: "INVALID_STATUS", message: `Current status: ${request.status}` });
    }

    // PVE ?占쎈뱶 ?占쎈쫫 議고쉶
    const pveNode = await prisma.pveNode.findUnique({ where: { id: nodeId } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    await prisma.vmRequest.update({
      where: { id },
      data: {
        status: "APPROVED",
        nodeId,
        node: pveNode.name,
        vmSource: vmSource || "cloud-image",
        sourceTemplateVmid: sourceTemplateVmid ? parseInt(sourceTemplateVmid) : null,
        cloudImageVolid: cloudImageVolid || null,
        startVmid: startVmid ? parseInt(String(startVmid)) : null,
        startNumber: parseInt(String(startNumber)) || 1,
        startIp,
        gatewayIp,
        dnsPrimary: dnsPrimary || null,
        dnsSecondary: dnsSecondary || null,
        storagePool,
        networkBridge,
        sshPort: parseInt(String(sshPort)) || 2211,
        vmUser: vmUser || "nexususer",
        fsType: fsType || "xfs",
        reviewedBy: req.user!.id,
        reviewedAt: new Date(),
        reviewNote: reviewNote || null,
      },
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_REQUEST_APPROVE",
      result: "SUCCESS",
      groupId: request.groupId,
      reason: `Approved VM request: ${request.instanceType} x${request.vmCount} on ${pveNode.name}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] VM request approve error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/vm-requests/:id/reject - ?占쎌껌 諛섎젮
 */
adminApi.patch("/vm-requests/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { reviewNote } = req.body;

  try {
    const request = await prisma.vmRequest.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: "REQUEST_NOT_FOUND" });

    if (!["REQUESTED", "QUOTA_EXCEEDED"].includes(request.status)) {
      return res.status(400).json({ error: "INVALID_STATUS", message: `Current status: ${request.status}` });
    }

    await prisma.vmRequest.update({
      where: { id },
      data: {
        status: "REJECTED",
        reviewedBy: req.user!.id,
        reviewedAt: new Date(),
        reviewNote: reviewNote || null,
      },
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_REQUEST_REJECT",
      result: "SUCCESS",
      groupId: request.groupId,
      reason: `Rejected VM request: ${request.instanceType} x${request.vmCount}${reviewNote ? ` - ${reviewNote}` : ""}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] VM request reject error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/vm-requests/:id/approve-quota - 荑쇳꽣 珥덇낵 ?占쎌껌 ?占쎌씤
 * 洹몃９ 荑쇳꽣占??占쎌슂?占쎄퉴吏 ?占쎈룞 利앾옙? ??REQUESTED占??占쏀솚
 */
adminApi.patch("/vm-requests/:id/approve-quota", async (req, res) => {
  const { id } = req.params;
  const { reviewNote } = req.body;

  try {
    const request = await prisma.vmRequest.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: "REQUEST_NOT_FOUND" });

    if (request.status !== "QUOTA_EXCEEDED") {
      return res.status(400).json({ error: "INVALID_STATUS", message: `Current status: ${request.status}` });
    }

    // ?占쎌옱 ?占쎌슜??議고쉶
    const usage = await getGroupQuotaUsage(request.groupId);

    // ?占쎌슂??留뚰겮 荑쇳꽣 ?占쎈룞 利앾옙?
    const totalCpu = usage.used.cpuCores + usage.pending.cpuCores + request.cpuCores * request.vmCount;
    const totalMem = usage.used.memoryMb + usage.pending.memoryMb + request.memoryMb * request.vmCount;
    const totalDisk = usage.used.diskGb + usage.pending.diskGb +
      (request.diskSizeGb + request.extraDiskGb * request.extraDiskCount) * request.vmCount;
    const totalVm = usage.used.vmCount + usage.pending.vmCount + request.vmCount;

    // 荑쇳꽣媛 -1(臾댁젣?????占쎈땶 ??占쏙옙占??占쎈뜲?占쏀듃
    const newQuota: any = {};
    if (usage.quota.maxCpuCores !== -1 && totalCpu > usage.quota.maxCpuCores) {
      newQuota.maxCpuCores = totalCpu;
    }
    if (usage.quota.maxMemoryMb !== -1 && totalMem > usage.quota.maxMemoryMb) {
      newQuota.maxMemoryMb = totalMem;
    }
    if (usage.quota.maxDiskGb !== -1 && totalDisk > usage.quota.maxDiskGb) {
      newQuota.maxDiskGb = totalDisk;
    }
    if (usage.quota.maxVmCount !== -1 && totalVm > usage.quota.maxVmCount) {
      newQuota.maxVmCount = totalVm;
    }

    if (Object.keys(newQuota).length > 0) {
      await prisma.groupQuota.upsert({
        where: { groupId: request.groupId },
        create: {
          groupId: request.groupId,
          ...newQuota,
        },
        update: newQuota,
      });
    }

    // Update request status
    await prisma.vmRequest.update({
      where: { id },
      data: {
        status: "REQUESTED",
        reviewNote: reviewNote ? `[荑쇳꽣 ?占쎌씤] ${reviewNote}` : "[荑쇳꽣 ?占쎌씤]",
      },
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_REQUEST_APPROVE_QUOTA",
      result: "SUCCESS",
      groupId: request.groupId,
      reason: `Approved quota increase for group. Updated: ${JSON.stringify(newQuota)}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true, quotaUpdated: newQuota });
  } catch (e: any) {
    console.error("[Admin] VM request approve-quota error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /api/admin/vm-requests/:id/deploy - ?占쎌씤???占쎌껌 諛고룷 ?占쏀뻾
 */
adminApi.post("/vm-requests/:id/deploy", async (req, res) => {
  const { id } = req.params;

  try {
    const request = await prisma.vmRequest.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: "REQUEST_NOT_FOUND" });

    if (request.status !== "APPROVED") {
      return res.status(400).json({ error: "NOT_APPROVED", message: `Current status: ${request.status}` });
    }

    if (!request.nodeId || !request.startIp || !request.gatewayIp || !request.storagePool || !request.networkBridge) {
      return res.status(400).json({ error: "MISSING_INFRA_FIELDS" });
    }

    const pveNode = await prisma.pveNode.findUnique({ where: { id: request.nodeId } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    let resolvedStartVmid = request.startVmid || 100;
    if (!request.startVmid) {
      const client = new ProxmoxClient(
        pveNode.host,
        pveNode.tokenId,
        decryptText(pveNode.tokenSecret)
      );
      resolvedStartVmid = await client.findNextAvailableVmid(100);
    }

    // DeployTask ?占쎌꽦
    const task = await prisma.deployTask.create({
      data: {
        groupId: request.groupId,
        node: request.node!,
        templateName: request.instanceType,
        vmSource: request.vmSource || "cloud-image",
        sourceTemplateVmid: request.sourceTemplateVmid,
        cloudImageVolid: request.cloudImageVolid,
        vmCount: request.vmCount,
        startVmid: resolvedStartVmid,
        hostnamePrefix: request.hostnamePrefix,
        startNumber: request.startNumber,
        startIp: request.startIp,
        gatewayIp: request.gatewayIp,
        dnsPrimary: request.dnsPrimary,
        dnsSecondary: request.dnsSecondary,
        storagePool: request.storagePool,
        networkBridge: request.networkBridge,
        sshPort: request.sshPort,
        vmUser: request.vmUser,
        cpuCores: request.cpuCores,
        memoryMb: request.memoryMb,
        diskSizeGb: request.diskSizeGb,
        extraDiskGb: request.extraDiskGb,
        extraDiskCount: request.extraDiskCount,
        fsType: request.fsType,
        createdBy: req.user!.id,
      },
    });

    // Update request status
    await prisma.vmRequest.update({
      where: { id },
      data: {
        status: "DEPLOYING",
        deployTaskId: task.id,
        startVmid: resolvedStartVmid,
      },
    });

    // 諛깃렇?占쎌슫??諛고룷 ?占쏀뻾
    const { executeDeploy } = await import("../../services/deployEngine");
    executeDeploy(task.id, request.nodeId!).catch((err) => {
      console.error(`[Deploy] Background execution failed for task ${task.id}:`, err);
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_REQUEST_DEPLOY",
      result: "SUCCESS",
      groupId: request.groupId,
      reason: `Started deployment for request: ${request.instanceType} x${request.vmCount}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true, taskId: task.id, jobId: task.jobId });
  } catch (e: any) {
    console.error("[Admin] VM request deploy error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /api/admin/vm-requests/:id/retry - 실패/부분완료 요청 재배포
 */
adminApi.post("/vm-requests/:id/retry", async (req, res) => {
  const { id } = req.params;

  try {
    const request = await prisma.vmRequest.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: "REQUEST_NOT_FOUND" });

    if (!["FAILED", "PARTIAL"].includes(request.status)) {
      return res.status(400).json({ error: "NOT_RETRYABLE", message: `Current status: ${request.status}` });
    }

    if (!request.nodeId || !request.startIp || !request.gatewayIp || !request.storagePool || !request.networkBridge) {
      return res.status(400).json({ error: "MISSING_INFRA_FIELDS" });
    }

    const pveNode = await prisma.pveNode.findUnique({ where: { id: request.nodeId } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    // 이전 배포에서 이미 성공한 VM 수 파악
    let alreadyCreated = 0;
    let existingJobId: string | null = null;
    if (request.deployTaskId) {
      const prevTask = await prisma.deployTask.findUnique({
        where: { id: request.deployTaskId },
        select: { jobId: true, completedVms: true },
      });
      if (prevTask) {
        alreadyCreated = prevTask.completedVms || 0;
        // 이전 Job이 있고 VM이 등록되어 있으면 재사용
        if (alreadyCreated > 0) {
          const existingJob = await prisma.job.findUnique({
            where: { jobId: prevTask.jobId },
          });
          if (existingJob) existingJobId = prevTask.jobId;
        }
      }
    }

    const remainingVmCount = request.vmCount - alreadyCreated;
    if (remainingVmCount <= 0) {
      return res.status(400).json({ error: "ALL_VMS_ALREADY_CREATED", message: `All ${request.vmCount} VMs were already created.` });
    }

    // IP를 이미 성공한 수만큼 건너뜀
    const { incrementIp } = await import("../../services/cloudInit");
    const retryStartIp = alreadyCreated > 0
      ? incrementIp(request.startIp, alreadyCreated)
      : request.startIp;

    let resolvedStartVmid = request.startVmid || 100;
    const client = new ProxmoxClient(
      pveNode.host,
      pveNode.tokenId,
      decryptText(pveNode.tokenSecret)
    );
    resolvedStartVmid = await client.findNextAvailableVmid(resolvedStartVmid);

    const task = await prisma.deployTask.create({
      data: {
        ...(existingJobId ? { jobId: existingJobId } : {}),
        groupId: request.groupId,
        node: request.node!,
        templateName: request.instanceType,
        vmSource: request.vmSource || "cloud-image",
        sourceTemplateVmid: request.sourceTemplateVmid,
        cloudImageVolid: request.cloudImageVolid,
        vmCount: remainingVmCount,
        startVmid: resolvedStartVmid,
        hostnamePrefix: request.hostnamePrefix,
        startNumber: request.startNumber + alreadyCreated,
        startIp: retryStartIp,
        gatewayIp: request.gatewayIp,
        dnsPrimary: request.dnsPrimary,
        dnsSecondary: request.dnsSecondary,
        storagePool: request.storagePool,
        networkBridge: request.networkBridge,
        sshPort: request.sshPort,
        vmUser: request.vmUser,
        cpuCores: request.cpuCores,
        memoryMb: request.memoryMb,
        diskSizeGb: request.diskSizeGb,
        extraDiskGb: request.extraDiskGb,
        extraDiskCount: request.extraDiskCount,
        fsType: request.fsType,
        createdBy: req.user!.id,
      },
    });

    await prisma.vmRequest.update({
      where: { id },
      data: {
        status: "DEPLOYING",
        deployTaskId: task.id,
        startVmid: resolvedStartVmid,
      },
    });

    const { executeDeploy } = await import("../../services/deployEngine");
    executeDeploy(task.id, request.nodeId!, existingJobId).catch((err) => {
      console.error(`[Deploy] Background retry execution failed for task ${task.id}:`, err);
    });

    await writeAudit({
      userId: req.user!.id,
      action: "VM_REQUEST_RETRY_DEPLOY",
      result: "SUCCESS",
      groupId: request.groupId,
      reason: `Retried deployment for request: ${request.instanceType} x${remainingVmCount} (${alreadyCreated} already created)`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true, taskId: task.id, jobId: task.jobId });
  } catch (e: any) {
    console.error("[Admin] VM request retry error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧??//  洹몃９ ?占쎈떦??愿占?// ?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧?占썩븧??
/**
 * GET /api/admin/group-quotas - ?占쎌껜 洹몃９ ?占쎈떦??議고쉶
 */
adminApi.get("/group-quotas", async (req, res) => {
  try {
    const groups = await prisma.group.findMany({
      include: { quota: true },
      orderBy: { name: "asc" },
    });

    const quotas = await Promise.all(
      groups.map(async (group) => {
        try {
          return await getGroupQuotaUsage(group.id);
        } catch {
          return {
            groupId: group.id,
            groupName: group.name,
            quota: { maxCpuCores: -1, maxMemoryMb: -1, maxDiskGb: -1, maxVmCount: -1 },
            used: { cpuCores: 0, memoryMb: 0, diskGb: 0, vmCount: 0 },
            pending: { cpuCores: 0, memoryMb: 0, diskGb: 0, vmCount: 0 },
            available: { cpuCores: -1, memoryMb: -1, diskGb: -1, vmCount: -1 },
          };
        }
      })
    );

    res.json({ ok: true, quotas });
  } catch (e: any) {
    console.error("[Admin] Group quotas list error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PUT /api/admin/group-quotas/:groupId - 洹몃９ ?占쎈떦???占쎌젙
 */
adminApi.put("/group-quotas/:groupId", async (req, res) => {
  const { groupId } = req.params;
  const { maxCpuCores, maxMemoryMb, maxDiskGb, maxVmCount } = req.body;

  try {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) return res.status(404).json({ error: "GROUP_NOT_FOUND" });

    const quota = await prisma.groupQuota.upsert({
      where: { groupId },
      create: {
        groupId,
        maxCpuCores: parseInt(String(maxCpuCores)) ?? -1,
        maxMemoryMb: parseInt(String(maxMemoryMb)) ?? -1,
        maxDiskGb: parseInt(String(maxDiskGb)) ?? -1,
        maxVmCount: parseInt(String(maxVmCount)) ?? -1,
      },
      update: {
        maxCpuCores: parseInt(String(maxCpuCores)) ?? -1,
        maxMemoryMb: parseInt(String(maxMemoryMb)) ?? -1,
        maxDiskGb: parseInt(String(maxDiskGb)) ?? -1,
        maxVmCount: parseInt(String(maxVmCount)) ?? -1,
      },
    });

    await writeAudit({
      userId: req.user!.id,
      action: "GROUP_QUOTA_UPDATE",
      result: "SUCCESS",
      groupId,
      reason: `Updated quota: CPU=${maxCpuCores}, Mem=${maxMemoryMb}MB, Disk=${maxDiskGb}GB, VMs=${maxVmCount}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true, quota });
  } catch (e: any) {
    console.error("[Admin] Group quota update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});


// ─── Backup & Restore ─────────────────────────────────────────────────────────

// POST /api/admin/backup/create  — Create a new backup archive
adminApi.post("/backup/create", requireLogin, requireAdmin, async (req, res) => {
  try {
    console.log("[Admin] Backup creation requested by:", req.user!.email);
    const filename = await createBackup();

    await writeAudit({
      userId: req.user!.id,
      action: "BACKUP_CREATE",
      result: "SUCCESS",
      reason: `Backup created: ${filename}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    notifyAuditEvent({
      action: 'backup_created',
      result: 'SUCCESS',
      userEmail: req.user!.email,
      reason: `수동 백업: ${filename}`,
      ipAddress: getClientIp(req),
    }).catch(() => {});

    res.json({ ok: true, filename });
  } catch (e: any) {
    console.error("[Admin] Backup create error:", e);
    res.status(500).json({ error: e.message || "BACKUP_FAILED" });
  }
});

// GET /api/admin/backup/list  — List all backup archives
adminApi.get("/backup/list", requireLogin, requireAdmin, (_req, res) => {
  try {
    const backups = listBackups();
    res.json({ ok: true, backups });
  } catch (e: any) {
    console.error("[Admin] Backup list error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// GET /api/admin/backup/schedule  — Get auto-backup schedule config (must be before :filename)
adminApi.get("/backup/schedule", requireLogin, requireAdmin, async (_req, res) => {
  try {
    const schedule = await getBackupSchedule();
    res.json({ ok: true, schedule });
  } catch (e: any) {
    console.error("[Admin] Backup schedule get error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// GET /api/admin/backup/:filename/download  — Download a backup file
adminApi.get("/backup/:filename/download", requireLogin, requireAdmin, (req, res) => {
  try {
    const filepath = getBackupPath(req.params.filename);
    res.download(filepath, req.params.filename);
  } catch (e: any) {
    console.error("[Admin] Backup download error:", e);
    res.status(404).json({ error: "BACKUP_NOT_FOUND" });
  }
});

// POST /api/admin/backup/:filename/restore  — Restore directly from an existing server-side backup
adminApi.post("/backup/:filename/restore", requireLogin, requireAdmin, async (req, res) => {
  try {
    const filepath = getBackupPath(req.params.filename); // validates filename safety + existence
    const restoreType = (req.body.type as string) || "config";
    if (!["config", "full"].includes(restoreType)) {
      return res.status(400).json({ error: "INVALID_RESTORE_TYPE" });
    }

    await writeAudit({
      userId: req.user!.id,
      action: "BACKUP_RESTORE",
      result: "SUCCESS",
      reason: `Restore from existing backup: type=${restoreType}, file=${req.params.filename}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    notifyAuditEvent({
      action: 'backup_restored',
      result: 'SUCCESS',
      userEmail: req.user!.email,
      reason: `복구 유형: ${restoreType === 'full' ? '전체 DB' : '설정만'} — ${req.params.filename}`,
      ipAddress: getClientIp(req),
    }).catch(() => {});

    if (restoreType === "config") {
      await restoreConfig(filepath);
      return res.json({ ok: true, message: "Config restored successfully" });
    } else {
      res.json({ ok: true, message: "Full DB restore initiated. Service will restart shortly." });
      restoreFullDb(filepath).catch((err) => {
        console.error("[Admin] Full restore error:", err);
      });
    }
  } catch (e: any) {
    console.error("[Admin] Restore from existing backup error:", e);
    if (!res.headersSent) {
      res.status(e.message === "Backup file not found" ? 404 : 500).json({ error: e.message || "RESTORE_FAILED" });
    }
  }
});

// DELETE /api/admin/backup/:filename  — Delete a backup file
adminApi.delete("/backup/:filename", requireLogin, requireAdmin, async (req, res) => {
  try {
    deleteBackup(req.params.filename);

    await writeAudit({
      userId: req.user!.id,
      action: "BACKUP_DELETE",
      result: "SUCCESS",
      reason: `Backup deleted: ${req.params.filename}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[Admin] Backup delete error:", e);
    res.status(404).json({ error: "BACKUP_NOT_FOUND" });
  }
});

// POST /api/admin/backup/restore  — Restore from an uploaded backup archive
adminApi.post(
  "/backup/restore",
  requireLogin,
  requireAdmin,
  restoreUpload.single("backup"),
  async (req, res) => {
    const fs = await import("fs");
    const uploadedPath = (req.file as any)?.path as string | undefined;
    try {
      if (!req.file || !uploadedPath) {
        return res.status(400).json({ error: "NO_FILE_UPLOADED" });
      }

      const restoreType = (req.body.type as string) || "config";
      if (!["config", "full"].includes(restoreType)) {
        return res.status(400).json({ error: "INVALID_RESTORE_TYPE" });
      }

      await writeAudit({
        userId: req.user!.id,
        action: "BACKUP_RESTORE",
        result: "SUCCESS",
        reason: `Restore started: type=${restoreType}, file=${req.file.originalname}`,
        requestIp: getClientIp(req),
        userAgent: req.get("user-agent") || "",
      });

      notifyAuditEvent({
        action: 'backup_restored',
        result: 'SUCCESS',
        userEmail: req.user!.email,
        reason: `복구 유형: ${restoreType === 'full' ? '전체 DB' : '설정만'} — ${req.file.originalname} (업로드)`,
        ipAddress: getClientIp(req),
      }).catch(() => {});

      if (restoreType === "config") {
        await restoreConfig(uploadedPath);
        if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
        return res.json({ ok: true, message: "Config restored successfully" });
      } else {
        // Full DB restore — send response before process exits
        res.json({ ok: true, message: "Full DB restore initiated. Service will restart shortly." });
        // restoreFullDb calls process.exit(0) after 2s
        restoreFullDb(uploadedPath).catch((err) => {
          console.error("[Admin] Full restore error:", err);
          if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
        });
      }
    } catch (e: any) {
      console.error("[Admin] Restore error:", e);
      if (uploadedPath && fs.existsSync(uploadedPath)) {
        try { fs.unlinkSync(uploadedPath); } catch { /* ignore */ }
      }
      if (!res.headersSent) {
        res.status(500).json({ error: e.message || "RESTORE_FAILED" });
      }
    }
  }
);

// PATCH /api/admin/backup/schedule  — Update auto-backup schedule config
adminApi.patch("/backup/schedule", requireLogin, requireAdmin, async (req, res) => {
  try {
    const { enabled, scheduleType, hour, weekdays, retentionDays } = req.body;

    const current = await getBackupSchedule();
    const updated = {
      ...current,
      enabled:      typeof enabled === "boolean" ? enabled : current.enabled,
      scheduleType: ["daily", "weekly"].includes(scheduleType) ? scheduleType : current.scheduleType,
      hour:         Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : current.hour,
      weekdays:     Array.isArray(weekdays) ? weekdays.map(Number).filter(n => n >= 0 && n <= 6) : current.weekdays,
      retentionDays: Number(retentionDays) || current.retentionDays,
    };

    await saveBackupSchedule(updated);
    reloadBackupScheduler();

    await writeAudit({
      userId: req.user!.id,
      action: "BACKUP_SCHEDULE_UPDATE",
      result: "SUCCESS",
      reason: `Backup schedule: enabled=${updated.enabled}, type=${updated.scheduleType}, hour=${updated.hour}, weekdays=[${updated.weekdays}], retention=${updated.retentionDays}d`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    notifyAuditEvent({
      action: 'backup_schedule_update',
      result: 'SUCCESS',
      userEmail: req.user!.email,
      reason: `활성화: ${updated.enabled}, 유형: ${updated.scheduleType}, 시각: ${String(updated.hour).padStart(2,'0')}:00, 보존: ${updated.retentionDays}일`,
      ipAddress: getClientIp(req),
    }).catch(() => {});

    res.json({ ok: true, schedule: updated });
  } catch (e: any) {
    console.error("[Admin] Backup schedule update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ─── 하이퍼바이저별 VM 인벤토리 ──────────────────────────────────────────────

/** GET /api/admin/vm-inventory — 노드별 VM 목록 (삭제되지 않은 VM) */
adminApi.get("/vm-inventory", requireLogin, requireAdmin, async (_req, res) => {
  try {
    const vms = await prisma.vm.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        vmid: true,
        hostname: true,
        ip: true,
        status: true,
        node: true,
        osType: true,
        cpuCores: true,
        memoryMb: true,
        diskSizeGb: true,
        lastSyncedAt: true,
        disks: { select: { slot: true, sizeGb: true, storage: true } },
        group: { select: { name: true } },
      },
      orderBy: [{ node: "asc" }, { hostname: "asc" }],
    });

    // 노드별 그룹핑
    const nodeMap: Record<string, typeof vms> = {};
    const unassigned: typeof vms = [];

    for (const vm of vms) {
      const key = vm.node ?? "";
      if (!key) {
        unassigned.push(vm);
      } else {
        if (!nodeMap[key]) nodeMap[key] = [];
        nodeMap[key].push(vm);
      }
    }

    const nodes = Object.entries(nodeMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, vmList]) => ({ node, vmCount: vmList.length, vms: vmList }));

    res.json({ ok: true, nodes, unassigned, total: vms.length });
  } catch (e: any) {
    console.error("[Admin] VM inventory error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ─── PVE 호스트 리소스 현황 ────────────────────────────────────────────────────

/** GET /api/admin/pve-node-resources — Proxmox 노드별 실시간 CPU/RAM/스토리지 현황 */
adminApi.get("/pve-node-resources", requireLogin, requireAdmin, async (_req, res) => {
  try {
    // DB에서 VM 디스크 할당량 집계 (thin 스토리지 used 보정용)
    // diskSizeGb = 전체 디스크 합산 캐시 (VmDisk sum)
    const [vmDiskRows, vmDiskTotal] = await Promise.all([
      // 노드별 합산 (ZFS 로컬 스토리지용)
      prisma.vm.groupBy({
        by: ["node"],
        where: { deletedAt: null, node: { not: null } },
        _sum: { diskSizeGb: true },
      }),
      // 전체 합산 (Ceph 클러스터 스토리지 할당량 추정용)
      prisma.vm.aggregate({
        where: { deletedAt: null },
        _sum: { diskSizeGb: true },
      }),
    ]);
    // node name → bytes
    const vmDiskByNode: Record<string, number> = {};
    vmDiskRows.forEach((row) => {
      if (row.node) {
        vmDiskByNode[row.node] = (row._sum.diskSizeGb ?? 0) * 1024 * 1024 * 1024;
      }
    });
    // 전체 VM 디스크 할당량 → bytes (Ceph pool 할당 추정)
    const vmDiskTotalBytes = (vmDiskTotal._sum.diskSizeGb ?? 0) * 1024 * 1024 * 1024;

    const pveNodes = await prisma.pveNode.findMany({ orderBy: { name: "asc" } });

    const results: Array<{
      nodeDbName: string;
      host: string;
      isOnline: boolean;
      lastChecked: Date | null;
      nodes: Array<{
        node: string;
        status: string;
        cpu: number;
        maxcpu: number;
        mem: number;
        maxmem: number;
        uptime: number;
        storage: Array<{
          storage: string;
          type: string;
          avail: number;
          total: number;
          used: number;
          active: number;
          pool?: string;
        }>;
      }>;
      error?: string;
    }> = [];

    await Promise.all(
      pveNodes.map(async (pveNode) => {
        try {
          const client = new ProxmoxClient(
            pveNode.host,
            pveNode.tokenId,
            decryptText(pveNode.tokenSecret)
          );
          const r = await client.getNodes();
          if (r.ok && r.data) {
            // 각 물리 노드별로 스토리지 풀 병렬 조회
            const nodesWithStorage = await Promise.all(
              r.data.map(async (n) => {
                const sr = await client.getStoragePools(n.node);
                return {
                  ...n,
                  storage: sr.ok && sr.data ? sr.data : [],
                };
              })
            );
            results.push({
              nodeDbName: pveNode.name,
              host: pveNode.host,
              isOnline: pveNode.isOnline,
              lastChecked: pveNode.lastChecked,
              nodes: nodesWithStorage,
            });
          } else {
            results.push({
              nodeDbName: pveNode.name,
              host: pveNode.host,
              isOnline: pveNode.isOnline,
              lastChecked: pveNode.lastChecked,
              nodes: [],
              error: r.error,
            });
          }
        } catch (e: any) {
          results.push({
            nodeDbName: pveNode.name,
            host: pveNode.host,
            isOnline: pveNode.isOnline,
            lastChecked: pveNode.lastChecked,
            nodes: [],
            error: e.message,
          });
        }
      })
    );

    res.json({ ok: true, results, vmDiskByNode, vmDiskTotalBytes });
  } catch (e: any) {
    console.error("[Admin] PVE node resources error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ─── VM 동기화 ───────────────────────────────────────────────────────────────

/** GET /api/admin/sync-status — 마지막 VM 동기화 시각 및 현황 */
adminApi.get("/sync-status", requireLogin, requireAdmin, async (_req, res) => {
  try {
    const onlineNodes = await prisma.pveNode.findMany({ where: { isOnline: true }, select: { name: true } });
    const onlineNodeNames = onlineNodes.map(n => n.name);

    const [lastSyncAgg, totalActive, syncedCount] = await Promise.all([
      prisma.vm.aggregate({
        where: { deletedAt: null, lastSyncedAt: { not: null } },
        _max: { lastSyncedAt: true },
      }),
      prisma.vm.count({ where: { deletedAt: null, node: { in: onlineNodeNames } } }),
      prisma.vm.count({ where: { deletedAt: null, lastSyncedAt: { not: null }, node: { in: onlineNodeNames } } }),
    ]);
    res.json({
      ok: true,
      lastSyncedAt: lastSyncAgg._max.lastSyncedAt,
      totalActive,
      syncedCount,
    });
  } catch (e: any) {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/** POST /api/admin/sync-vms — 수동 즉시 동기화 */
adminApi.post("/sync-vms", requireLogin, requireAdmin, async (req, res) => {
  try {
    await syncAllVmStatuses();

    const onlineNodes = await prisma.pveNode.findMany({ where: { isOnline: true }, select: { name: true } });
    const onlineNodeNames = onlineNodes.map(n => n.name);

    const [lastSyncAgg, totalActive, syncedCount] = await Promise.all([
      prisma.vm.aggregate({
        where: { deletedAt: null, lastSyncedAt: { not: null } },
        _max: { lastSyncedAt: true },
      }),
      prisma.vm.count({ where: { deletedAt: null, node: { in: onlineNodeNames } } }),
      prisma.vm.count({ where: { deletedAt: null, lastSyncedAt: { not: null }, node: { in: onlineNodeNames } } }),
    ]);

    await writeAudit({
      userId: req.user!.id,
      action: "VM_SYNC_MANUAL",
      result: "SUCCESS",
      reason: `수동 동기화 완료: ${syncedCount}/${totalActive}개 VM`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({
      ok: true,
      lastSyncedAt: lastSyncAgg._max.lastSyncedAt,
      totalActive,
      syncedCount,
    });
  } catch (e: any) {
    console.error("[Admin] Manual VM sync error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ─── 통계 대시보드 ───────────────────────────────────────────────────────────

adminApi.get("/stats", requireLogin, requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const twelveMonthsAgo = new Date(now - 365 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [
      vmsByGroup,
      groups,
      topRequesterIds,
      monthlyRequests,
      requestsByGroupStatus,
      completedRequests,
      loginLogs,
      topEvents,
      vmStatusCounts,
      vmOsTypeCounts,
      allRequestStatusCounts,
      dailyVmRegs,
      nodeVmCounts,
    ] = await Promise.all([
      // 1. 그룹별 VM 수 (삭제되지 않은 VM만)
      prisma.vm.groupBy({
        by: ["groupId"],
        where: { deletedAt: null },
        _count: { id: true },
      }),

      // 2. 그룹 전체 (쿼터 + VM 수 포함)
      prisma.group.findMany({
        include: {
          quota: true,
          vms: { where: { deletedAt: null }, select: { id: true, cpuCores: true, memoryMb: true, diskSizeGb: true } },
        },
        orderBy: { name: "asc" },
      }),

      // 3. 사용자별 VM 요청 수 TOP 10 (userId 기준)
      prisma.vmRequest.groupBy({
        by: ["requestedBy"],
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      }),

      // 4. 최근 12개월 요청 목록 (월별 집계용)
      prisma.vmRequest.findMany({
        where: { createdAt: { gte: twelveMonthsAgo } },
        select: { createdAt: true, status: true },
      }),

      // 5. 그룹별 요청 상태 분포
      prisma.vmRequest.groupBy({
        by: ["groupId", "status"],
        _count: { id: true },
      }),

      // 6. 완료된 요청 (평균 처리 시간 계산용)
      prisma.vmRequest.findMany({
        where: {
          status: { in: ["COMPLETED", "APPROVED", "DEPLOYING"] },
          reviewedAt: { not: null },
        },
        select: { createdAt: true, reviewedAt: true, updatedAt: true, status: true },
      }),

      // 7. 최근 30일 로그인 로그 (시간대별 분포용)
      prisma.auditLog.findMany({
        where: {
          action: { in: ["LOGIN_SUCCESS", "login_success"] },
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { createdAt: true },
      }),

      // 8. 최근 30일 이벤트 빈도 TOP 10
      prisma.auditLog.groupBy({
        by: ["action"],
        where: { createdAt: { gte: thirtyDaysAgo } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
      }),

      // 9. VM 상태별 분포 (running/stopped/paused/unknown)
      prisma.vm.groupBy({
        by: ["status"],
        where: { deletedAt: null },
        _count: { id: true },
      }),

      // 10. VM OS 타입별 분포 (linux/windows)
      prisma.vm.groupBy({
        by: ["osType"],
        where: { deletedAt: null },
        _count: { id: true },
      }),

      // 11. 전체 요청 상태별 합계 (전 기간)
      prisma.vmRequest.groupBy({
        by: ["status"],
        _count: { id: true },
      }),

      // 12. 최근 30일 일별 VM 등록 수
      prisma.vm.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
      }),

      // 13. 노드별 VM 분포
      prisma.vm.groupBy({
        by: ["node"],
        where: { deletedAt: null, node: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),
    ]);

    // 그룹 이름 맵
    const groupNameMap: Record<string, string> = {};
    for (const g of groups) groupNameMap[g.id] = g.name;

    // 요청자 userId → email 매핑
    const requesterUserIds = topRequesterIds.map((r) => r.requestedBy);
    const requesterUsers = await prisma.user.findMany({
      where: { id: { in: requesterUserIds } },
      select: { id: true, email: true },
    });
    const requesterEmailMap: Record<string, string> = {};
    for (const u of requesterUsers) requesterEmailMap[u.id] = u.email;

    // 그룹별 VM 수 (이름 포함)
    const vmsByGroupNamed = vmsByGroup.map((row) => ({
      groupName: groupNameMap[row.groupId] ?? row.groupId,
      count: row._count.id,
    }));

    // 그룹별 쿼터 사용률
    const quotaUsage = groups.map((g) => ({
      groupName: g.name,
      vmCount: g.vms.length,
      maxVmCount: g.quota?.maxVmCount ?? -1,
      usedCpu: g.vms.reduce((s, v) => s + (v.cpuCores ?? 0), 0),
      maxCpu: g.quota?.maxCpuCores ?? -1,
      usedMem: g.vms.reduce((s, v) => s + (v.memoryMb ?? 0), 0),
      maxMem: g.quota?.maxMemoryMb ?? -1,
      usedDisk: g.vms.reduce((s, v) => s + (v.diskSizeGb ?? 0), 0),
      maxDisk: g.quota?.maxDiskGb ?? -1,
    }));

    // 월별 요청 집계 (최근 12개월)
    const monthlyMap: Record<string, { total: number; completed: number }> = {};
    for (const req of monthlyRequests) {
      const key = `${req.createdAt.getFullYear()}-${String(req.createdAt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = { total: 0, completed: 0 };
      monthlyMap[key].total++;
      if (req.status === "COMPLETED") monthlyMap[key].completed++;
    }
    const monthlyData = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, val]) => ({ month, ...val }));

    // 그룹별 요청 상태 집계 (이름 포함)
    const groupRequestMap: Record<string, Record<string, number>> = {};
    for (const row of requestsByGroupStatus) {
      const name = groupNameMap[row.groupId] ?? row.groupId;
      if (!groupRequestMap[name]) groupRequestMap[name] = {};
      groupRequestMap[name][row.status] = (groupRequestMap[name][row.status] ?? 0) + row._count.id;
    }

    // 평균 처리 시간 (요청 → 검토)
    let totalApprovalMs = 0;
    let approvalCount = 0;
    for (const r of completedRequests) {
      if (r.reviewedAt) {
        totalApprovalMs += r.reviewedAt.getTime() - r.createdAt.getTime();
        approvalCount++;
      }
    }
    const avgApprovalHours = approvalCount > 0 ? Math.round(totalApprovalMs / approvalCount / 36000) / 100 : null;

    // 시간대별 로그인 분포 (0~23)
    const loginByHour = Array(24).fill(0);
    for (const log of loginLogs) {
      loginByHour[log.createdAt.getHours()]++;
    }

    // 이벤트 빈도 TOP 10
    const topEventsNamed = topEvents.map((e) => ({
      action: e.action,
      count: e._count.id,
    }));

    // 일별 VM 등록 추이 (최근 30일)
    const dailyVmMap: Record<string, number> = {};
    for (const vm of dailyVmRegs) {
      const key = vm.createdAt.toISOString().slice(0, 10);
      dailyVmMap[key] = (dailyVmMap[key] ?? 0) + 1;
    }
    const dailyVmData = Object.entries(dailyVmMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    res.json({
      ok: true,
      vmsByGroup: vmsByGroupNamed,
      quotaUsage,
      topRequesters: topRequesterIds.map((r) => ({
        email: requesterEmailMap[r.requestedBy] ?? r.requestedBy,
        count: r._count.id,
      })),
      monthlyData,
      groupRequestMap,
      avgApprovalHours,
      loginByHour,
      topEvents: topEventsNamed,
      vmStatusCounts: vmStatusCounts.map((r) => ({ status: r.status ?? "unknown", count: r._count.id })),
      vmOsTypeCounts: vmOsTypeCounts.map((r) => ({ osType: r.osType, count: r._count.id })),
      allRequestStatusCounts: allRequestStatusCounts.map((r) => ({ status: r.status, count: r._count.id })),
      dailyVmData,
      nodeVmCounts: nodeVmCounts.map((r) => ({ node: r.node ?? "unknown", count: r._count.id })),
    });
  } catch (e: any) {
    console.error("[Admin] Stats error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ─── 테마 템플릿 설정 ────────────────────────────────────────────────────────

/**
 * GET /api/admin/theme-template — 현재 선택된 템플릿 조회
 */
adminApi.get("/theme-template", requireLogin, requireAdmin, async (_req, res) => {
  try {
    const cfg = await prisma.systemConfig.findUnique({ where: { key: "theme_template" } });
    const current = resolveTemplate(cfg?.value);
    res.json({ ok: true, template: current, options: getTemplateOptions() });
  } catch (e: any) {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * PATCH /api/admin/theme-template — 템플릿 변경 저장
 */
adminApi.patch("/theme-template", requireLogin, requireAdmin, async (req, res) => {
  try {
    const { template } = req.body;
    if (!template || !isValidTemplate(template)) {
      return res.status(400).json({ error: "INVALID_TEMPLATE" });
    }

    await prisma.systemConfig.upsert({
      where: { key: "theme_template" },
      update: { value: template, updatedAt: new Date() },
      create: {
        id: `sc-theme-template-${Date.now()}`,
        key: "theme_template",
        value: template,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await writeAudit({
      userId: req.user!.id,
      action: "THEME_TEMPLATE_UPDATE",
      result: "SUCCESS",
      reason: `테마 템플릿 변경: ${template}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true, template, options: getTemplateOptions() });
  } catch (e: any) {
    console.error("[Admin] Theme template update error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

