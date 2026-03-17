/**
 * Auto-Rotate Scheduler
 *
 * SystemConfig key: "auto_rotate_policy"
 * Value (JSON):
 *   {
 *     enabled: boolean,
 *     scheduleMode: "interval" | "monthly",
 *     // interval mode:
 *     intervalDays: number,          // e.g., 90
 *     // monthly mode:
 *     intervalMonths: number,        // e.g., 3 → 분기마다
 *     dayOfMonth: number,            // 1~31, 31 = 말일(last day of month)
 *     targetTypes: ("linux_key" | "windows_password")[],
 *     lastRunAt: string | null       // ISO date
 *   }
 *
 * Runs on startup (after 15s delay) and every hour thereafter.
 * Sends Slack/email notification via notifyAuditEvent on failure.
 */

import crypto from "crypto";
import { prisma } from "./prisma";
import { ProxmoxClient } from "./proxmox";
import { encryptText, decryptText } from "./crypto";
import { writeAudit } from "./audit";
import { notifyAuditEvent } from "./slack";

// ─── Policy ───

export interface AutoRotatePolicy {
  enabled: boolean;
  scheduleMode: "interval" | "monthly";
  // interval mode
  intervalDays: number;
  // monthly mode
  intervalMonths: number;
  dayOfMonth: number;  // 1-31 (31 = 말일)
  runAtHour: number;   // 0-23
  runAtMinute: number; // 0-59
  targetTypes: ("linux_key" | "windows_password")[];
  lastRunAt: string | null;
}

const DEFAULT_POLICY: AutoRotatePolicy = {
  enabled: false,
  scheduleMode: "interval",
  intervalDays: 90,
  intervalMonths: 3,
  dayOfMonth: 1,
  runAtHour: 0,
  runAtMinute: 0,
  targetTypes: ["linux_key", "windows_password"],
  lastRunAt: null,
};

/**
 * VM별 교체 기한 기준일 계산
 * lastRotatedAt 이 이 날짜보다 오래됐거나 null 이면 교체 대상
 */
function calcCutoffDate(policy: AutoRotatePolicy): Date {
  const now = new Date();
  if (policy.scheduleMode === "interval") {
    const d = new Date(now);
    d.setDate(d.getDate() - policy.intervalDays);
    return d;
  }
  // monthly mode
  const d = new Date(now);
  d.setMonth(d.getMonth() - (policy.intervalMonths || 1));
  return d;
}

/**
 * 다음 실행 예정 시각 계산
 */
export function calcNextRunAt(policy: AutoRotatePolicy): Date | null {
  if (!policy.enabled) return null;

  const h = policy.runAtHour ?? 0;
  const m = policy.runAtMinute ?? 0;

  if (policy.scheduleMode === "interval") {
    const base = policy.lastRunAt ? new Date(policy.lastRunAt) : new Date();
    const next = new Date(base);
    if (policy.lastRunAt) {
      next.setDate(next.getDate() + policy.intervalDays);
    }
    next.setHours(h, m, 0, 0);
    return next;
  }

  // monthly mode: lastRunAt 기준 intervalMonths 후의 dayOfMonth
  // 31 선택 시 항상 말일. 그 외에도 해당 달 마지막 날로 클램프 (예: 30일 선택 시 2월은 28/29일)
  const base = policy.lastRunAt ? new Date(policy.lastRunAt) : new Date();
  const next = new Date(base);
  next.setMonth(next.getMonth() + (policy.intervalMonths || 1));
  const lastDayOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(policy.dayOfMonth, lastDayOfMonth));
  next.setHours(h, m, 0, 0);
  return next;
}

/**
 * 지금 실행해야 하는지 판단
 */
function isDue(policy: AutoRotatePolicy): boolean {
  if (!policy.enabled) return false;
  const next = calcNextRunAt(policy);
  if (!next) return false;
  return new Date() >= next;
}

export async function getAutoRotatePolicy(): Promise<AutoRotatePolicy> {
  try {
    const config = await prisma.systemConfig.findUnique({ where: { key: "auto_rotate_policy" } });
    if (config) return { ...DEFAULT_POLICY, ...JSON.parse(config.value) };
  } catch {}
  return { ...DEFAULT_POLICY };
}

export async function saveAutoRotatePolicy(policy: AutoRotatePolicy): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key: "auto_rotate_policy" },
    create: { key: "auto_rotate_policy", value: JSON.stringify(policy) },
    update: { value: JSON.stringify(policy) },
  });
}

// ─── SSH key helpers (shared logic) ───

function derToOpenSshRsa(derBuf: Buffer): string {
  const key = crypto.createPublicKey({ key: derBuf, format: "der", type: "pkcs1" });
  const jwk = key.export({ format: "jwk" });
  const e = Buffer.from(jwk.e as string, "base64url");
  const n = Buffer.from(jwk.n as string, "base64url");
  const typeStr = Buffer.from("ssh-rsa");
  const parts = [typeStr, e, n];
  const encoded = parts.map((p) => {
    let buf = p;
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(buf.length);
    return Buffer.concat([lenBuf, buf]);
  });
  return Buffer.concat(encoded).toString("base64");
}

function generateSshKeyPair(): { publicKey: string; privateKey: string; fingerprint: string } {
  const { publicKey: pubPem, privateKey: privPem } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const pubKeyObj = crypto.createPublicKey(pubPem);
  const pubDer = pubKeyObj.export({ type: "pkcs1", format: "der" });
  const sshPublicKey = `ssh-rsa ${derToOpenSshRsa(pubDer)} vm-automation`;
  const fpHash = crypto.createHash("sha256")
    .update(Buffer.from(derToOpenSshRsa(pubDer), "base64"))
    .digest("base64").replace(/=+$/, "");
  return { publicKey: sshPublicKey, privateKey: privPem, fingerprint: `SHA256:${fpHash}` };
}

function generateWindowsPassword(): string {
  const upper   = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower   = "abcdefghjkmnpqrstuvwxyz";
  const digits  = "23456789";
  const special = "@#$%^*()_+!=-";
  const pool    = upper + lower + digits + special;
  const required = [
    upper  [crypto.randomInt(upper.length)],
    upper  [crypto.randomInt(upper.length)],
    lower  [crypto.randomInt(lower.length)],
    lower  [crypto.randomInt(lower.length)],
    digits [crypto.randomInt(digits.length)],
    digits [crypto.randomInt(digits.length)],
    special[crypto.randomInt(special.length)],
    special[crypto.randomInt(special.length)],
  ];
  const extra = Array.from({ length: 8 }, () => pool[crypto.randomInt(pool.length)]);
  const chars = [...required, ...extra];
  const shuffleBytes = crypto.randomBytes(chars.length);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ─── Guest Agent helpers ───

async function getClientForVm(node: string): Promise<{ client: ProxmoxClient } | { client: null; error: string }> {
  const anyNode = await prisma.pveNode.findFirst({ where: { name: node } });
  if (!anyNode) return { client: null, error: "Proxmox 연결 설정이 없습니다. 관리자 페이지에서 Proxmox 노드를 등록해주세요." };
  if (!anyNode.isOnline) return { client: null, error: "Proxmox 서버에 연결할 수 없습니다. 네트워크 또는 인증 정보를 확인해주세요." };
  return { client: new ProxmoxClient(anyNode.host, anyNode.tokenId, decryptText(anyNode.tokenSecret)) };
}

async function agentRun(
  client: ProxmoxClient,
  node: string,
  vmid: number,
  cmd: string,
  timeoutMs = 30_000
): Promise<{ exitcode: number; stdout: string; stderr: string }> {
  const execResult = await client.agentExec(node, vmid, ["bash", "-c", cmd]);
  if (!execResult.ok || execResult.data?.pid === undefined) {
    throw new Error(`agent/exec 실패: ${execResult.error}`);
  }
  const pid = execResult.data.pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    const statusResult = await client.agentExecStatus(node, vmid, pid);
    if (!statusResult.ok) throw new Error(`exec-status 오류: ${statusResult.error}`);
    const s = statusResult.data!;
    if (s.exited) {
      return { exitcode: s.exitcode ?? -1, stdout: s["out-data"] ?? "", stderr: s["err-data"] ?? "" };
    }
  }
  throw new Error(`agent/exec 타임아웃 (${timeoutMs / 1000}s)`);
}

async function agentRunRaw(
  client: ProxmoxClient,
  node: string,
  vmid: number,
  command: string[],
  timeoutMs = 30_000
): Promise<{ exitcode: number; stdout: string; stderr: string }> {
  const execResult = await client.agentExec(node, vmid, command);
  if (!execResult.ok || execResult.data?.pid === undefined) {
    throw new Error(`agent/exec 실패: ${execResult.error}`);
  }
  const pid = execResult.data.pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    const statusResult = await client.agentExecStatus(node, vmid, pid);
    if (!statusResult.ok) throw new Error(`exec-status 오류: ${statusResult.error}`);
    const s = statusResult.data!;
    if (s.exited) {
      return { exitcode: s.exitcode ?? -1, stdout: s["out-data"] ?? "", stderr: s["err-data"] ?? "" };
    }
  }
  throw new Error(`agent/exec 타임아웃 (${timeoutMs / 1000}s)`);
}

async function rotateKeyViaAgent(
  client: ProxmoxClient,
  node: string,
  vmid: number,
  oldPublicKey: string,
  newPublicKey: string,
  vmUser: string
): Promise<void> {
  const authKeysPath = vmUser === "root"
    ? "/root/.ssh/authorized_keys"
    : `/home/${vmUser}/.ssh/authorized_keys`;

  const newKeyBody = newPublicKey.split(" ")[1];
  const escapedNewKey = newPublicKey.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");

  const addScript =
    `mkdir -p $(dirname ${authKeysPath}) && chown ${vmUser}:${vmUser} $(dirname ${authKeysPath}) && chmod 700 $(dirname ${authKeysPath}) && ` +
    `grep -qF '${newKeyBody}' ${authKeysPath} 2>/dev/null || ` +
    `echo '${escapedNewKey}' >> ${authKeysPath} && chown ${vmUser}:${vmUser} ${authKeysPath} && chmod 600 ${authKeysPath}`;

  const addResult = await agentRun(client, node, vmid, addScript);
  if (addResult.exitcode !== 0) {
    throw new Error(`새 키 추가 실패 (exit ${addResult.exitcode}): ${addResult.stderr}`);
  }

  const verifyScript = `grep -qF '${newKeyBody}' ${authKeysPath} && echo OK || echo FAIL`;
  const verifyResult = await agentRun(client, node, vmid, verifyScript);
  if (verifyResult.stdout.trim() !== "OK") {
    throw new Error(`새 키 검증 실패: 파일에 존재하지 않습니다.`);
  }
}

async function removeOldKeyFromAgent(
  client: ProxmoxClient,
  node: string,
  vmid: number,
  oldPublicKey: string,
  vmUser: string
): Promise<void> {
  const authKeysPath = vmUser === "root"
    ? "/root/.ssh/authorized_keys"
    : `/home/${vmUser}/.ssh/authorized_keys`;

  const oldKeyBody = oldPublicKey.split(" ")[1];
  const removeScript =
    `python3 -c "` +
      `import os; f='${authKeysPath}'; ` +
      `lines=open(f).readlines() if os.path.exists(f) else []; ` +
      `lines=[l for l in lines if '${oldKeyBody}' not in l]; ` +
      `open(f,'w').writelines(lines)"`;   // 원본 파일 덮어쓰기 → 소유권 유지
  await agentRun(client, node, vmid, removeScript);
}

// ─── Per-VM rotation ───

async function rotateLinuxKey(vm: any): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!vm.node || !vm.vmid) return { ok: false, error: "VM_NO_NODE_INFO" };
    const clientResult = await getClientForVm(vm.node);
    if (!clientResult.client) return { ok: false, error: clientResult.error };
    const client = clientResult.client;

    const vmStatus = await client.getVmStatus(vm.node, vm.vmid);
    if (!vmStatus.ok || vmStatus.data?.status !== "running") {
      return { ok: false, error: `VM_NOT_RUNNING (${vmStatus.data?.status ?? "unknown"})` };
    }

    // QEMU Guest Agent 응답 확인 (부팅 중이거나 agent 미설치 시 스킵)
    const ping = await client.agentPing(vm.node, vm.vmid);
    if (!ping.ok) {
      return { ok: false, error: `AGENT_NOT_READY: ${ping.error}` };
    }

    const oldKey = vm.job?.key;
    if (!oldKey) return { ok: false, error: "NO_KEY" };

    const deployTask = vm.jobId
      ? await prisma.deployTask.findFirst({ where: { jobId: vm.jobId }, orderBy: { createdAt: "desc" } })
      : null;
    const vmUser = deployTask?.vmUser || "nexususer";

    const { publicKey: newPublicKey, privateKey: newPrivateKey, fingerprint: newFingerprint } = generateSshKeyPair();
    const keyVersion = `v${Date.now()}`;

    await rotateKeyViaAgent(client, vm.node, vm.vmid, oldKey.publicKey, newPublicKey, vmUser);

    const oldFingerprint = oldKey.fingerprint;
    await prisma.$transaction(async (tx) => {
      await tx.key.create({
        data: { fingerprint: newFingerprint, keyVersion, publicKey: newPublicKey, privateKeyEnc: encryptText(newPrivateKey) },
      });
      await tx.job.update({ where: { jobId: vm.jobId }, data: { keyFingerprint: newFingerprint } });
      // 참조 없는 경우만 원자적으로 삭제 (동시 실행 레이스 안전)
      await tx.key.deleteMany({ where: { fingerprint: oldFingerprint, jobs: { none: {} } } });
    });

    try { await removeOldKeyFromAgent(client, vm.node, vm.vmid, oldKey.publicKey, vmUser); } catch {}

    // VM별 마지막 교체 성공 시각 갱신 (재시도 기준)
    await prisma.vm.update({ where: { id: vm.id }, data: { lastRotatedAt: new Date() } });

    await writeAudit({
      action: "KEY_ROTATE_AUTO",
      result: "SUCCESS",
      reason: `[자동] Old:${oldFingerprint} → New:${newFingerprint}`,
      vmId: vm.id,
      vmHostname: vm.hostname,
      requestIp: "system",
      userAgent: "auto-rotate-scheduler",
    });

    return { ok: true };
  } catch (e: any) {
    await writeAudit({
      action: "KEY_ROTATE_AUTO",
      result: "FAIL",
      reason: `[자동] ${e.message}`,
      vmId: vm.id,
      vmHostname: vm.hostname,
      requestIp: "system",
      userAgent: "auto-rotate-scheduler",
    }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

async function rotateWindowsPassword(vm: any): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!vm.node || !vm.vmid) return { ok: false, error: "VM_NO_NODE_INFO" };
    const clientResult = await getClientForVm(vm.node);
    if (!clientResult.client) return { ok: false, error: clientResult.error };
    const client = clientResult.client;

    const vmStatus = await client.getVmStatus(vm.node, vm.vmid);
    if (!vmStatus.ok || vmStatus.data?.status !== "running") {
      return { ok: false, error: `VM_NOT_RUNNING (${vmStatus.data?.status ?? "unknown"})` };
    }

    // QEMU Guest Agent 응답 확인
    const ping = await client.agentPing(vm.node, vm.vmid);
    if (!ping.ok) {
      return { ok: false, error: `AGENT_NOT_READY: ${ping.error}` };
    }

    if (!vm.winUsername) return { ok: false, error: "WIN_USERNAME_NOT_SET" };

    const newPassword = generateWindowsPassword();
    const result = await agentRunRaw(client, vm.node, vm.vmid, ["net.exe", "user", vm.winUsername, newPassword]);
    if (result.exitcode !== 0) {
      return { ok: false, error: `net user 실패 (exit ${result.exitcode}): ${result.stderr}` };
    }

    await prisma.vm.update({ where: { id: vm.id }, data: { winPasswordEnc: encryptText(newPassword), lastRotatedAt: new Date() } });

    await writeAudit({
      action: "WIN_PW_ROTATE_AUTO",
      result: "SUCCESS",
      reason: `[자동] Windows 비밀번호 교체: ${vm.winUsername}`,
      vmId: vm.id,
      vmHostname: vm.hostname,
      requestIp: "system",
      userAgent: "auto-rotate-scheduler",
    });

    return { ok: true };
  } catch (e: any) {
    await writeAudit({
      action: "WIN_PW_ROTATE_AUTO",
      result: "FAIL",
      reason: `[자동] ${e.message}`,
      vmId: vm.id,
      vmHostname: vm.hostname,
      requestIp: "system",
      userAgent: "auto-rotate-scheduler",
    }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// ─── Main rotation run ───

export async function runAutoRotation(force = false): Promise<{ ran: boolean; failures: string[]; rotated: number; connError?: string }> {
  const policy = await getAutoRotatePolicy();
  if (!policy.enabled && !force) return { ran: false, failures: [], rotated: 0 };

  // force=true 이면 전체 대상, 아니면 기한 초과 VM만 대상
  const cutoff = force ? null : calcCutoffDate(policy);
  const now = new Date();
  // lastRotatedAt를 미래로 설정한 VM은 자동 교체 제외(배포/수동다운로드 제외 정책)
  const unlockedWhere = {
    OR: [{ lastRotatedAt: null }, { lastRotatedAt: { lte: now } }],
  };
  // cutoff 기준: lastRotatedAt IS NULL 또는 cutoff 이전 → 교체 대상
  const overdueWhere = cutoff
    ? { OR: [{ lastRotatedAt: null }, { lastRotatedAt: { lt: cutoff } }] }
    : undefined;

  // ── Proxmox 연결 선제 확인 ──
  const totalNodes = await prisma.pveNode.count();
  if (totalNodes === 0) {
    return { ran: false, failures: [], rotated: 0, connError: "Proxmox 연결 설정이 없습니다. 관리자 페이지에서 Proxmox 노드를 등록해주세요." };
  }
  const onlineNodes = await prisma.pveNode.count({ where: { isOnline: true } });
  if (onlineNodes === 0) {
    return { ran: false, failures: [], rotated: 0, connError: "Proxmox 서버에 연결할 수 없습니다. 네트워크 또는 인증 정보를 확인해주세요." };
  }

  const failures: string[] = [];
  let rotated = 0;

  // 동시 처리 수 제한 (Proxmox API 과부하 방지)
  const CONCURRENCY = 5;
  async function runBatch<T>(
    items: T[],
    fn: (item: T) => Promise<{ ok: boolean; error?: string }>,
    label: (item: T) => string
  ) {
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(fn));
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled" && r.value.ok) { rotated++; }
        else {
          const err = r.status === "fulfilled" ? r.value.error : String((r as any).reason);
          failures.push(`${label(batch[j])}: ${err}`);
        }
      }
    }
  }

  if (policy.targetTypes.includes("linux_key")) {
    const linuxVms = await prisma.vm.findMany({
      where: {
        deletedAt: null,
        osType: { not: "windows" },
        jobId: { not: null },
        node: { not: null },
        vmid: { not: null },
        AND: [
          unlockedWhere,
          ...(overdueWhere ? [overdueWhere] : []),
        ],
      },
      include: { job: { include: { key: true } } },
      take: 500, // 1회 실행당 최대 500대 (나머지는 다음 3분 주기에 처리)
    });

    await runBatch(
      linuxVms.filter(vm => vm.job?.key),
      rotateLinuxKey,
      vm => `Linux ${vm.hostname || vm.vmid} (${vm.id})`
    );
  }

  if (policy.targetTypes.includes("windows_password")) {
    const windowsVms = await prisma.vm.findMany({
      where: {
        deletedAt: null,
        osType: "windows",
        winUsername: { not: null },
        node: { not: null },
        vmid: { not: null },
        AND: [
          unlockedWhere,
          ...(overdueWhere ? [overdueWhere] : []),
        ],
      },
      take: 500,
    });

    await runBatch(
      windowsVms,
      rotateWindowsPassword,
      vm => `Windows ${vm.hostname || vm.vmid} (${vm.id})`
    );
  }

  if (rotated === 0 && failures.length === 0) {
    return { ran: false, failures: [], rotated: 0 };
  }

  console.log(`[AutoRotate] Run complete. rotated=${rotated}, failures=${failures.length}`);

  // Update lastRunAt (관리자 페이지 표시용)
  const updated = { ...policy, lastRunAt: new Date().toISOString() };
  await saveAutoRotatePolicy(updated);

  console.log(`[AutoRotate] Done. failures=${failures.length}`);

  if (rotated > 0) {
    await notifyAuditEvent({
      action: "KEY_ROTATE_AUTO",
      result: "SUCCESS",
      reason: `${rotated}대 자동 교체 완료${failures.length > 0 ? `, ${failures.length}대 실패` : ""}`,
    }).catch(console.error);
  }

  if (failures.length > 0) {
    // 실패 알림 쓰로틀: 30분에 1회만 발송 (VM 꺼짐 등 반복 실패 시 스팸 방지)
    const now = Date.now();
    if (!_lastFailureNotifiedAt || now - _lastFailureNotifiedAt > 30 * 60 * 1000) {
      _lastFailureNotifiedAt = now;
      await notifyAuditEvent({
        action: "AUTO_ROTATE",
        result: "FAIL",
        reason: `${failures.length}개 VM 자동 교체 실패:\n${failures.join("\n")}`,
      }).catch(console.error);
    }
  }

  return { ran: true, failures, rotated };
}

// ─── Scheduler lifecycle ───

let _timer: NodeJS.Timeout | null = null;
let _running = false; // 겹침 실행 방지
let _lastFailureNotifiedAt: number | null = null; // 실패 알림 쓰로틀 기준

/**
 * force/scheduled 모두 이 함수를 통해 실행 → 겹침 방지 보장
 * force=true: 기한 무관 전체 대상 / false: 기한 초과 VM만
 */
export async function triggerAutoRotation(force = false): Promise<{ ran: boolean; failures: string[]; rotated: number; connError?: string }> {
  if (_running) {
    console.log(`[AutoRotate] Run already in progress, skipping (force=${force}).`);
    return { ran: false, failures: [], rotated: 0, connError: "교체 작업이 이미 진행 중입니다." };
  }
  _running = true;
  try {
    return await runAutoRotation(force);
  } finally {
    _running = false;
  }
}

export function startAutoRotateScheduler(): void {
  // Check on startup after short delay (DB/Redis warmup)
  setTimeout(() => triggerAutoRotation().catch(console.error), 15_000);
  // VM sync와 동일한 3분 주기로 체크 (VM 켜진 후 최대 3분 내 재시도)
  _timer = setInterval(() => triggerAutoRotation().catch(console.error), 3 * 60 * 1000);
  console.log("[AutoRotate] Scheduler started (3min check).");
}

export function stopAutoRotateScheduler(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
