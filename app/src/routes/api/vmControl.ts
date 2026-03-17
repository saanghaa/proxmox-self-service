/**
 * VM 전원 관리 API (사용자용)
 * 시작/중지/재부팅 - 그룹 소속 확인 후 Proxmox API 호출
 */

import { Router } from "express";
import crypto from "crypto";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../../services/prisma";
import { ProxmoxClient } from "../../services/proxmox";
import { encryptText, decryptText } from "../../services/crypto";
import { requireLogin } from "../middlewares/requireLogin";
import { writeAudit } from "../../services/audit";
import { notifyAuditEvent } from "../../services/slack";
import { getClientIp } from "../../utils/requestIp";
import { verifyTotp } from "../../services/totp";
import { config } from "../../config";

export const vmControlApi = Router();
vmControlApi.use(requireLogin);

const redis = new Redis(config.redisUrl);

/**
 * Proxmox 클라이언트를 VM의 노드 정보로 생성
 */
async function getClientForVm(node: string) {
  const pveNode = await prisma.pveNode.findFirst({
    where: { name: node, isOnline: true },
  });
  if (!pveNode) return null;

  return new ProxmoxClient(
    pveNode.host,
    pveNode.tokenId,
    decryptText(pveNode.tokenSecret)
  );
}

/**
 * POST /api/vms/:id/start
 */
vmControlApi.post("/:id/start", async (req, res) => {
  await handlePowerAction(req, res, "start");
});

/**
 * POST /api/vms/:id/stop
 */
vmControlApi.post("/:id/stop", async (req, res) => {
  await handlePowerAction(req, res, "stop");
});

/**
 * POST /api/vms/:id/reboot
 */
vmControlApi.post("/:id/reboot", async (req, res) => {
  await handlePowerAction(req, res, "reboot");
});

/**
 * DELETE /api/vms/:id
 * VM 소프트 삭제 (사용자용)
 */
vmControlApi.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const vm = await prisma.vm.findUnique({
      where: { id },
      include: { group: true },
    });

    if (!vm || vm.deletedAt) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    // 그룹 소속 확인
    const membership = await prisma.groupMembership.findFirst({
      where: { userId, groupId: vm.groupId },
    });
    if (!membership && !(req.user as any).isAdmin) {
      return res.status(403).json({ error: "NOT_GROUP_MEMBER" });
    }

    // 먼저 Proxmox에서 VM 중지
    if (vm.node && vm.vmid) {
      try {
        const client = await getClientForVm(vm.node);
        if (client) {
          await client.stopVm(vm.node, vm.vmid);
        }
      } catch (e) {
        // 중지 실패해도 soft delete는 진행
      }
    }

    // Soft delete
    await prisma.vm.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedBy: userId,
        status: "stopped",
      },
    });

    await writeAudit({
      userId,
      action: "VM_DELETE",
      result: "SUCCESS",
      groupId: vm.groupId,
      vmId: vm.id,
      reason: `Soft-deleted VM: ${vm.hostname} (VMID: ${vm.vmid})`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[VmControl] Delete error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ─── SSH 키 생성 (deployEngine.ts에서 복사) ───

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

// ─── Windows 비밀번호 생성 ───

function generateWindowsPassword(): string {
  const upper   = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // I, O 제외 (혼동 방지)
  const lower   = "abcdefghjkmnpqrstuvwxyz";  // i, l, o 제외
  const digits  = "23456789";                 // 0, 1 제외
  // 제외 문자:
  //   /  → net user가 옵션으로 해석 (/add 등)
  //   \  → Windows 경로 구분자로 혼동 가능
  //   "' → 명령행 쿼팅 충돌
  //   스페이스 → 인수 분리
  // agentRunRaw는 cmd.exe 없이 직접 exec이므로 %, ^, ! 등은 안전
  const special = "@#$%^*()_+!=-";
  const pool    = upper + lower + digits + special;

  // 각 문자 유형 2개 이상 보장 + 총 16자
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

  // Fisher-Yates shuffle
  const shuffleBytes = crypto.randomBytes(chars.length);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ─── Guest Agent 명령 실행 + 폴링 공통 헬퍼 ───

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
      return {
        exitcode: s.exitcode ?? -1,
        stdout: s["out-data"] ?? "",
        stderr: s["err-data"] ?? "",
      };
    }
  }
  throw new Error(`agent/exec 타임아웃 (${timeoutMs / 1000}s)`);
}

// Windows Guest Agent: 명령 배열을 직접 전달 (shell 불필요, 이스케이프 없음)
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
      return {
        exitcode: s.exitcode ?? -1,
        stdout: s["out-data"] ?? "",
        stderr: s["err-data"] ?? "",
      };
    }
  }
  throw new Error(`agent/exec 타임아웃 (${timeoutMs / 1000}s)`);
}

// ─── Guest Agent로 authorized_keys 교체 후 검증 ───
//
// 안전 순서:
//   1. 새 키 추가 (구 키 유지) → 이 시점부터 두 키 모두 접속 가능
//   2. 새 키 존재 검증 → 실패 시 에러 반환 (구 키는 여전히 유효)
//   3. (호출측) DB 업데이트 → 새 키가 공식 키가 됨
//   4. 구 키 제거 (best-effort) → 실패해도 기능상 무해

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

  const oldKeyBody = oldPublicKey.split(" ")[1];
  const newKeyBody = newPublicKey.split(" ")[1];
  const escapedNewKey = newPublicKey.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");

  // 1단계: 새 키를 추가 (append) — 구 키는 아직 유지, 중단돼도 기존 접속 가능
  const addScript =
    `mkdir -p $(dirname ${authKeysPath}) && chown ${vmUser}:${vmUser} $(dirname ${authKeysPath}) && chmod 700 $(dirname ${authKeysPath}) && ` +
    `grep -qF '${newKeyBody}' ${authKeysPath} 2>/dev/null || ` +
    `echo '${escapedNewKey}' >> ${authKeysPath} && chown ${vmUser}:${vmUser} ${authKeysPath} && chmod 600 ${authKeysPath}`;

  const addResult = await agentRun(client, node, vmid, addScript);
  if (addResult.exitcode !== 0) {
    throw new Error(`새 키 추가 실패 (exit ${addResult.exitcode}): ${addResult.stderr}`);
  }

  // 2단계: 새 키가 실제로 파일에 있는지 검증 — 실패 시 구 키가 살아있어 접속 가능
  const verifyScript = `grep -qF '${newKeyBody}' ${authKeysPath} && echo OK || echo FAIL`;
  const verifyResult = await agentRun(client, node, vmid, verifyScript);
  if (verifyResult.stdout.trim() !== "OK") {
    throw new Error(`새 키 검증 실패: 파일에 존재하지 않습니다.`);
  }

  // 여기까지 성공하면 새 키로 접속 가능 → 호출측에서 DB 업데이트
}

// 3단계: 구 키 제거 (DB 업데이트 후 호출, best-effort)
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

  // python3로 구 키 라인 제거 — 원본 파일에 직접 써서 소유권 유지
  const removeScript =
    `python3 -c "` +
      `import os; f='${authKeysPath}'; ` +
      `lines=open(f).readlines() if os.path.exists(f) else []; ` +
      `lines=[l for l in lines if '${oldKeyBody}' not in l]; ` +
      `open(f,'w').writelines(lines)"`;   // 원본 파일 덮어쓰기 → 소유권 유지

  await agentRun(client, node, vmid, removeScript);
  // 실패해도 무시 — 두 키가 모두 남아있을 뿐, 접속에 영향 없음
}

// ─── VM authorized_keys 현황 조회 ───

/**
 * GET /api/vms/:id/key-check
 * VM의 authorized_keys에 등록된 SSH 키 지문 목록을 Guest Agent로 조회
 * DB 등록 키와 실제 VM 키의 일치 여부를 반환
 */
vmControlApi.get("/:id/key-check", async (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const vm = await prisma.vm.findUnique({
      where: { id },
      include: { job: { include: { key: true } } },
    });

    if (!vm || vm.deletedAt) return res.status(404).json({ error: "VM_NOT_FOUND" });
    if (vm.osType === "windows") return res.status(400).json({ error: "WINDOWS_VM_NOT_SUPPORTED" });

    const membership = await prisma.groupMembership.findFirst({ where: { userId, groupId: vm.groupId } });
    if (!membership && !(req.user as any).isAdmin) return res.status(403).json({ error: "NOT_GROUP_MEMBER" });

    if (!vm.node || !vm.vmid) return res.status(400).json({ error: "VM_NO_NODE_INFO" });

    const client = await getClientForVm(vm.node);
    if (!client) return res.status(503).json({ error: "PVE_NODE_OFFLINE" });

    // DeployTask에서 vmUser 조회
    const deployTask = vm.jobId
      ? await prisma.deployTask.findUnique({ where: { jobId: vm.jobId }, select: { vmUser: true } })
      : null;
    const vmUser = deployTask?.vmUser ?? "nexususer";
    const authKeysPath = vmUser === "root"
      ? "/root/.ssh/authorized_keys"
      : `/home/${vmUser}/.ssh/authorized_keys`;

    // ssh-keygen -lf 로 각 키의 지문 출력 (없으면 빈 결과)
    // 출력 형식: "4096 SHA256:xxxx comment (RSA)"
    const result = await agentRun(
      client, vm.node, vm.vmid,
      `[ -f ${authKeysPath} ] && ssh-keygen -lf ${authKeysPath} 2>/dev/null || echo ""`
    );

    const vmFingerprints: string[] = result.stdout
      .trim()
      .split("\n")
      .map(line => line.match(/(SHA256:[^\s]+)/)?.[1] ?? "")
      .filter(Boolean);

    const dbFingerprint = vm.job?.key?.fingerprint ?? null;

    return res.json({
      vmUser,
      authKeysPath,
      vmFingerprints,                                       // VM에 실제 등록된 키 지문 목록
      dbFingerprint,                                        // DB에 등록된 공식 키 지문
      synced: dbFingerprint ? vmFingerprints.includes(dbFingerprint) : null,
      extraKeys: vmFingerprints.filter(f => f !== dbFingerprint), // DB 외 추가 키 (구 키 잔존 등)
    });
  } catch (e: any) {
    // 에러 메시지로 VM 꺼짐/Guest Agent 미설치 여부 판별
    const detail = e.message || "";
    if (detail.includes("타임아웃") || detail.includes("agent/exec 실패")) {
      return res.status(503).json({ error: "AGENT_UNAVAILABLE", detail });
    }
    console.error("[VmControl] key-check error:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ─── Windows 자격증명 조회 (사용자용) ───

/**
 * POST /api/vms/:id/reveal-credentials
 * 그룹 소속 사용자가 OTP 인증 후 Windows 자격증명 조회
 */
vmControlApi.post("/:id/reveal-credentials", async (req, res) => {
  const { id } = req.params;
  const { otp } = req.body || {};
  const userId = req.user!.id;

  try {
    if (!req.user?.totpEnabled || !(req.user as any).totpSecret) {
      return res.status(403).json({ error: "OTP_NOT_ENABLED" });
    }

    if (!otp || String(otp).trim().length < 6) {
      return res.status(400).json({ error: "MISSING_OTP" });
    }

    if (!verifyTotp(req.user!, String(otp).trim())) {
      return res.status(401).json({ error: "INVALID_OTP" });
    }

    const vm = await prisma.vm.findUnique({ where: { id } });
    if (!vm || vm.deletedAt) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    // 그룹 소속 확인
    const membership = await prisma.groupMembership.findFirst({
      where: { userId, groupId: vm.groupId },
    });
    if (!membership && !(req.user as any).isAdmin) {
      return res.status(403).json({ error: "NOT_GROUP_MEMBER" });
    }

    if (vm.osType !== "windows" || !vm.winPasswordEnc) {
      return res.status(400).json({ error: "NO_WINDOWS_CREDENTIALS" });
    }

    await writeAudit({
      userId,
      action: "VM_CREDENTIALS_REVEAL",
      result: "SUCCESS",
      vmId: vm.id,
      groupId: vm.groupId,
      reason: `Revealed Windows credentials for VM: ${vm.hostname || vm.vmid}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    return res.json({
      ok: true,
      username: vm.winUsername,
      password: decryptText(vm.winPasswordEnc),
    });
  } catch (e: any) {
    console.error("[VmControl] Reveal credentials error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// ─── Windows 비밀번호 교체 엔드포인트 ───

/**
 * POST /api/vms/:id/rotate-win-password/prepare
 * Windows VM 비밀번호 교체용 OTP 챌린지 발급
 */
vmControlApi.post("/:id/rotate-win-password/prepare", async (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const vm = await prisma.vm.findUnique({ where: { id } });

    if (!vm || vm.deletedAt) return res.status(404).json({ error: "VM_NOT_FOUND" });
    if (vm.osType !== "windows") return res.status(400).json({ error: "LINUX_VM_NOT_SUPPORTED" });
    if (!vm.winUsername) return res.status(400).json({ error: "WIN_USERNAME_NOT_SET" });
    if (!vm.node || !vm.vmid) return res.status(400).json({ error: "VM_NO_NODE_INFO" });

    const membership = await prisma.groupMembership.findFirst({ where: { userId, groupId: vm.groupId } });
    if (!membership && !(req.user as any).isAdmin) return res.status(403).json({ error: "NOT_GROUP_MEMBER" });

    // 키/비밀번호 교체 권한 정책 확인
    if (!(req.user as any).isAdmin) {
      const rotateModeCfg = await prisma.systemConfig.findUnique({ where: { key: "key_rotate_mode" } });
      const rotateMode = rotateModeCfg?.value ?? "admin_only";
      if (rotateMode === "admin_only") return res.status(403).json({ error: "ADMIN_ONLY_ACTION" });
    }

    const client = await getClientForVm(vm.node);
    if (!client) return res.status(503).json({ error: "PVE_NODE_OFFLINE" });

    // 1) VM 실행 상태 확인
    const vmStatusResult = await client.getVmStatus(vm.node, vm.vmid);
    if (!vmStatusResult.ok || vmStatusResult.data?.status !== "running") {
      return res.status(409).json({
        error: "VM_NOT_RUNNING",
        detail: `현재 VM 상태: ${vmStatusResult.data?.status ?? "unknown"}`,
      });
    }

    // 2) Windows Guest Agent 응답 확인 (10초 타임아웃)
    try {
      await agentRunRaw(client, vm.node, vm.vmid, ["cmd.exe", "/c", "echo ok"], 10_000);
    } catch {
      return res.status(503).json({
        error: "AGENT_UNAVAILABLE",
        detail: "Guest Agent가 응답하지 않습니다. qemu-guest-agent(Windows)가 설치·실행 중인지 확인하세요.",
      });
    }

    const challengeId = uuidv4();
    await redis.set(
      `winpw:${challengeId}`,
      JSON.stringify({ userId, vmId: id }),
      "EX", 60
    );

    return res.json({ challenge_id: challengeId, ttl_sec: 60 });
  } catch (e: any) {
    console.error("[VmControl] rotate-win-password/prepare error:", e);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/vms/:id/rotate-win-password
 * OTP 검증 후 Windows 비밀번호 교체 실행
 */
vmControlApi.post("/:id/rotate-win-password", async (req, res) => {
  const { id } = req.params;
  const { challenge_id, otp } = req.body || {};
  const userId = req.user!.id;
  const ip = getClientIp(req);
  const ua = req.get("user-agent") || "";

  if (!challenge_id || !otp) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  try {
    // 1. Redis 챌린지 검증
    const raw = await redis.get(`winpw:${challenge_id}`);
    if (!raw) {
      await writeAudit({ userId, action: "WIN_PASSWORD_ROTATE", result: "FAIL", reason: "CHALLENGE_EXPIRED", vmId: id, requestIp: ip, userAgent: ua });
      return res.status(410).json({ error: "CHALLENGE_EXPIRED" });
    }
    const ch = JSON.parse(raw);
    if (ch.userId !== userId || ch.vmId !== id) {
      await writeAudit({ userId, action: "WIN_PASSWORD_ROTATE", result: "FAIL", reason: "CHALLENGE_MISMATCH", vmId: id, requestIp: ip, userAgent: ua });
      return res.status(403).json({ error: "FORBIDDEN_ACCESS" });
    }

    // 2. OTP 검증
    if (!verifyTotp(req.user!, otp)) {
      await writeAudit({ userId, action: "WIN_PASSWORD_ROTATE", result: "FAIL", reason: "OTP_INVALID", vmId: id, requestIp: ip, userAgent: ua });
      return res.status(401).json({ error: "INVALID_OTP" });
    }

    // 3. 챌린지 즉시 소진
    await redis.del(`winpw:${challenge_id}`);

    // 4. VM 재조회
    const vm = await prisma.vm.findUnique({ where: { id } });
    if (!vm || vm.deletedAt || vm.osType !== "windows" || !vm.winUsername || !vm.node || !vm.vmid) {
      return res.status(400).json({ error: "VM_NOT_ELIGIBLE" });
    }

    // 5. Proxmox 클라이언트 생성
    const client = await getClientForVm(vm.node);
    if (!client) return res.status(503).json({ error: "PVE_NODE_OFFLINE" });

    // 6. 새 비밀번호 생성 (16자, shell 이스케이프 불필요)
    const newPassword = generateWindowsPassword();

    // 7. Guest Agent로 비밀번호 변경 — 직접 인수 전달로 특수문자 안전
    const changeResult = await agentRunRaw(
      client, vm.node, vm.vmid,
      ["net.exe", "user", vm.winUsername, newPassword]
    );

    if (changeResult.exitcode !== 0) {
      const detail = changeResult.stderr || changeResult.stdout || `exit ${changeResult.exitcode}`;
      await writeAudit({
        userId, action: "WIN_PASSWORD_ROTATE", result: "FAIL",
        reason: `AGENT_FAILED: ${detail}`,
        vmId: id, requestIp: ip, userAgent: ua,
      });
      return res.status(502).json({ error: "AGENT_EXEC_FAILED", detail });
    }

    // 8. DB 업데이트
    await prisma.vm.update({
      where: { id },
      data: { winPasswordEnc: encryptText(newPassword) },
    });

    // 9. 감사 로그
    await writeAudit({
      userId, action: "WIN_PASSWORD_ROTATE", result: "SUCCESS",
      vmId: id,
      reason: `Windows password rotated for user: ${vm.winUsername}`,
      requestIp: ip, userAgent: ua,
    });

    // 새 비밀번호를 응답에 포함 (1회 표시 후 클라이언트에서 폐기)
    return res.json({ ok: true, newPassword, username: vm.winUsername });
  } catch (e: any) {
    console.error("[VmControl] rotate-win-password error:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ─── SSH 키 교체 엔드포인트 ───

/**
 * POST /api/vms/:id/rotate-key/prepare
 * OTP 챌린지 발급
 */
vmControlApi.post("/:id/rotate-key/prepare", async (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const vm = await prisma.vm.findUnique({
      where: { id },
      include: { job: { include: { key: true } } },
    });

    if (!vm || vm.deletedAt) return res.status(404).json({ error: "VM_NOT_FOUND" });
    if (vm.osType === "windows") return res.status(400).json({ error: "WINDOWS_VM_NOT_SUPPORTED" });

    const membership = await prisma.groupMembership.findFirst({ where: { userId, groupId: vm.groupId } });
    if (!membership && !(req.user as any).isAdmin) return res.status(403).json({ error: "NOT_GROUP_MEMBER" });

    // 키 교체 권한 정책 확인
    if (!(req.user as any).isAdmin) {
      const rotateModeCfg = await prisma.systemConfig.findUnique({ where: { key: "key_rotate_mode" } });
      const rotateMode = rotateModeCfg?.value ?? "admin_only";
      if (rotateMode === "admin_only") return res.status(403).json({ error: "ADMIN_ONLY_ACTION" });
    }

    if (!vm.jobId) return res.status(400).json({ error: "VM_HAS_NO_JOB" });
    if (!vm.job?.key) return res.status(400).json({ error: "JOB_HAS_NO_KEY" });
    if (!vm.node || !vm.vmid) return res.status(400).json({ error: "VM_NO_NODE_INFO" });

    // ── 사전 체크: VM 전원 상태 + Guest Agent 응답 ──
    const client = await getClientForVm(vm.node);
    if (!client) return res.status(503).json({ error: "PVE_NODE_OFFLINE" });

    // 1) Proxmox에서 실시간 VM 상태 확인
    const vmStatusResult = await client.getVmStatus(vm.node, vm.vmid);
    if (!vmStatusResult.ok || vmStatusResult.data?.status !== "running") {
      return res.status(409).json({
        error: "VM_NOT_RUNNING",
        detail: `현재 VM 상태: ${vmStatusResult.data?.status ?? "unknown"}. 키 교체는 VM이 실행 중일 때만 가능합니다.`,
      });
    }

    // 2) Guest Agent 응답 확인 (10초 타임아웃)
    try {
      await agentRun(client, vm.node, vm.vmid, "echo ok", 10_000);
    } catch (agentErr: any) {
      return res.status(503).json({
        error: "AGENT_UNAVAILABLE",
        detail: "Guest Agent가 응답하지 않습니다. qemu-guest-agent가 설치·실행 중인지 확인하세요.",
      });
    }

    const challengeId = uuidv4();
    await redis.set(
      `rot:${challengeId}`,
      JSON.stringify({ userId, vmId: id, jobId: vm.jobId, fingerprint: vm.job.key.fingerprint }),
      "EX", 60
    );

    return res.json({ challenge_id: challengeId, ttl_sec: 60 });
  } catch (e: any) {
    console.error("[VmControl] rotate-key/prepare error:", e);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/vms/:id/rotate-key
 * OTP 검증 후 키 교체 실행
 */
vmControlApi.post("/:id/rotate-key", async (req, res) => {
  const { id } = req.params;
  const { challenge_id, otp } = req.body || {};
  const userId = req.user!.id;
  const ip = getClientIp(req);
  const ua = req.get("user-agent") || "";

  if (!challenge_id || !otp) return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });

  try {
    // 1. Redis 챌린지 검증
    const raw = await redis.get(`rot:${challenge_id}`);
    if (!raw) {
      await writeAudit({ userId, action: "KEY_ROTATE", result: "FAIL", reason: "CHALLENGE_EXPIRED", vmId: id, requestIp: ip, userAgent: ua });
      return res.status(410).json({ error: "CHALLENGE_EXPIRED" });
    }
    const ch = JSON.parse(raw);
    if (ch.userId !== userId || ch.vmId !== id) {
      await writeAudit({ userId, action: "KEY_ROTATE", result: "FAIL", reason: "CHALLENGE_MISMATCH", vmId: id, requestIp: ip, userAgent: ua });
      return res.status(403).json({ error: "FORBIDDEN_ACCESS" });
    }

    // 2. OTP 검증
    if (!verifyTotp(req.user!, otp)) {
      await writeAudit({ userId, action: "KEY_ROTATE", result: "FAIL", reason: "OTP_INVALID", vmId: id, requestIp: ip, userAgent: ua });
      return res.status(401).json({ error: "INVALID_OTP" });
    }

    // 3. 챌린지 즉시 소진
    await redis.del(`rot:${challenge_id}`);

    // 4. VM + Job + Key 재조회
    const vm = await prisma.vm.findUnique({
      where: { id },
      include: { job: { include: { key: true } } },
    });
    if (!vm || vm.deletedAt || vm.osType === "windows" || !vm.jobId || !vm.node || !vm.vmid) {
      return res.status(400).json({ error: "VM_NOT_ELIGIBLE" });
    }
    if (!vm.job?.key) return res.status(400).json({ error: "JOB_HAS_NO_KEY" });

    const oldKey = vm.job.key;

    // 5. DeployTask에서 vmUser 조회 (없으면 기본값)
    const deployTask = await prisma.deployTask.findUnique({
      where: { jobId: vm.jobId },
      select: { vmUser: true },
    });
    const vmUser = deployTask?.vmUser ?? "nexususer";

    // 6. Proxmox 클라이언트 생성
    const client = await getClientForVm(vm.node);
    if (!client) return res.status(503).json({ error: "PVE_NODE_OFFLINE" });

    // 7. 신규 키 생성
    const { publicKey: newPublicKey, privateKey: newPrivateKey, fingerprint: newFingerprint } = generateSshKeyPair();

    // 8. Guest Agent로 authorized_keys 교체 (실패 시 DB 변경 없음)
    try {
      await rotateKeyViaAgent(client, vm.node, vm.vmid, oldKey.publicKey, newPublicKey, vmUser);
    } catch (sshErr: any) {
      await writeAudit({
        userId, action: "KEY_ROTATE", result: "FAIL",
        reason: `AGENT_FAILED: ${sshErr.message}`,
        vmId: id, jobId: vm.jobId, fingerprint: oldKey.fingerprint,
        requestIp: ip, userAgent: ua,
      });
      return res.status(502).json({ error: "AGENT_EXEC_FAILED", detail: sshErr.message });
    }

    // 9. DB 업데이트 (새 키 검증 완료 후) — 트랜잭션으로 원자적 처리
    const keyVersion = `rotate-${vm.jobId.slice(0, 8)}-${Date.now().toString(36)}`;
    const oldJobId = vm.jobId;
    const oldFingerprint = oldKey.fingerprint;

    await prisma.$transaction(async (tx) => {
      await tx.key.create({
        data: { fingerprint: newFingerprint, keyVersion, publicKey: newPublicKey, privateKeyEnc: encryptText(newPrivateKey) },
      });
      await tx.job.update({
        where: { jobId: oldJobId },
        data: { keyFingerprint: newFingerprint },
      });
      // 구 키를 참조하는 Job이 더 없으면 삭제
      const oldRefCount = await tx.job.count({ where: { keyFingerprint: oldFingerprint } });
      if (oldRefCount === 0) {
        await tx.key.delete({ where: { fingerprint: oldFingerprint } });
      }
    });

    // 10. 구 키 제거 — 보안상 필수 (유출된 구 키 무효화), 결과를 반환에 포함
    let oldKeyRemoved = false;
    try {
      await removeOldKeyFromAgent(client, vm.node, vm.vmid, oldKey.publicKey, vmUser);
      oldKeyRemoved = true;
    } catch (rmErr: any) {
      console.warn("[VmControl] 구 키 제거 실패:", rmErr.message);
      // 제거 실패는 별도 WARN 로그로 기록 (새 키는 이미 유효)
      await writeAudit({
        userId, action: "KEY_ROTATE", result: "WARN",
        reason: `OLD_KEY_REMOVAL_FAILED: ${rmErr.message}`,
        vmId: id, jobId: vm.jobId, fingerprint: oldKey.fingerprint,
        requestIp: ip, userAgent: ua,
      });
    }

    // 11. 감사 로그 + 알림
    await writeAudit({
      userId, action: "KEY_ROTATE", result: "SUCCESS",
      vmId: id, jobId: vm.jobId, fingerprint: newFingerprint, keyVersion,
      reason: `Old: ${oldKey.fingerprint} → New: ${newFingerprint}`,
      requestIp: ip, userAgent: ua,
    });
    notifyAuditEvent({
      action: "KEY_ROTATE",
      result: "SUCCESS",
      userEmail: req.user!.email,
      vmHostname: vm.hostname || String(vm.vmid || ""),
      keyVersion,
      fingerprint: newFingerprint,
      ipAddress: ip,
      reason: `Old: ${oldKey.fingerprint} → New: ${newFingerprint}`,
    }).catch(console.error);

    return res.json({ ok: true, newFingerprint, keyVersion, oldKeyRemoved, privateKey: newPrivateKey });
  } catch (e: any) {
    console.error("[VmControl] rotate-key error:", e);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * 전원 액션 공통 핸들러
 */
async function handlePowerAction(
  req: any,
  res: any,
  action: "start" | "stop" | "reboot"
) {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const vm = await prisma.vm.findUnique({
      where: { id },
      include: { group: true },
    });

    if (!vm || vm.deletedAt) {
      return res.status(404).json({ error: "VM_NOT_FOUND" });
    }

    if (!vm.node || !vm.vmid) {
      return res.status(400).json({ error: "VM_NO_NODE_INFO" });
    }

    // 그룹 소속 확인
    const membership = await prisma.groupMembership.findFirst({
      where: { userId, groupId: vm.groupId },
    });
    if (!membership && !(req.user as any).isAdmin) {
      return res.status(403).json({ error: "NOT_GROUP_MEMBER" });
    }

    const client = await getClientForVm(vm.node);
    if (!client) {
      return res.status(503).json({ error: "PVE_NODE_OFFLINE" });
    }

    let result;
    switch (action) {
      case "start":
        result = await client.startVm(vm.node, vm.vmid);
        break;
      case "stop":
        result = await client.stopVm(vm.node, vm.vmid);
        break;
      case "reboot":
        result = await client.rebootVm(vm.node, vm.vmid);
        if (!result.ok) {
          // fallback: stop + start
          await client.stopVm(vm.node, vm.vmid);
          await new Promise((r) => setTimeout(r, 3000));
          result = await client.startVm(vm.node, vm.vmid);
        }
        break;
    }

    if (!result.ok) {
      return res.status(500).json({ error: result.error });
    }

    // 상태 업데이트
    const newStatus =
      action === "start" ? "running" : action === "stop" ? "stopped" : "running";
    await prisma.vm.update({
      where: { id },
      data: { status: newStatus, lastSyncedAt: new Date() },
    });

    await writeAudit({
      userId,
      action: `VM_${action.toUpperCase()}`,
      result: "SUCCESS",
      groupId: vm.groupId,
      vmId: vm.id,
      reason: `${action} VM: ${vm.hostname} (VMID: ${vm.vmid})`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true, status: newStatus });
  } catch (e: any) {
    console.error(`[VmControl] ${action} error:`, e);
    res.status(500).json({ error: e.message });
  }
}
