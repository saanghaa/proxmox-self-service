/**
 * VM 배포 엔진
 * DeployTask를 기반으로 Proxmox API를 통해 VM을 생성하는 백그라운드 프로세스
 */

import crypto from "crypto";
import { prisma } from "./prisma";
import { ProxmoxClient } from "./proxmox";
import { encryptText, decryptText } from "./crypto";
import { incrementIp } from "./cloudInit";
import { writeAudit } from "./audit";

const DEFAULT_VM_PASSWORD = process.env.DEFAULT_VM_PASSWORD || "Proxmox1!";
const PREDEFINED_CLOUDINIT_SNIPPET_FILE =
  process.env.PREDEFINED_CLOUDINIT_SNIPPET_FILE || "proxmox-cloud-init.yaml";

/**
 * 배포 실행 메인 함수
 */
export async function executeDeploy(
  taskId: string,
  pveNodeId: string,
  existingJobId?: string | null
): Promise<void> {
  const log = (msg: string) => console.log(`[Deploy:${taskId.slice(0, 8)}] ${msg}`);
  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizeHostnameBase = (prefix: string): string => {
    const normalized = String(prefix || "vm")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized) return "vm-dev";
    return normalized.endsWith("-dev") ? normalized : `${normalized}-dev`;
  };
  const parseVolid = (volid: string): { storage: string; path: string } | null => {
    const idx = volid.indexOf(":");
    if (idx <= 0 || idx >= volid.length - 1) return null;
    return { storage: volid.slice(0, idx), path: volid.slice(idx + 1) };
  };
  const waitForImportImageVisible = async (
    proxmoxClient: ProxmoxClient,
    node: string,
    storage: string,
    targetVolid: string,
    timeoutMs: number = 180000,
    intervalMs: number = 3000
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await proxmoxClient.getStorageContent(node, storage, "import");
      if (res.ok && Array.isArray(res.data)) {
        const found = res.data.some((it: any) => String(it?.volid || "") === targetVolid);
        if (found) return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Cloud image not visible in storage yet: ${targetVolid}`);
  };

  try {
    // ─── 초기화 ───
    const task = await prisma.deployTask.findUnique({ where: { id: taskId } });
    if (!task) throw new Error("Task not found");

    const pveNode = await prisma.pveNode.findUnique({ where: { id: pveNodeId } });
    if (!pveNode) throw new Error("PVE node not found");

    const client = new ProxmoxClient(
      pveNode.host,
      pveNode.tokenId,
      decryptText(pveNode.tokenSecret)
    );

    await updateTask(taskId, { status: "RUNNING", currentStep: "초기화 중..." });
    log("배포 시작");

    // ─── 1. SSH 키 생성 ───
    await updateTask(taskId, { currentStep: "SSH 키 생성 중..." });
    const { publicKey, privateKey, fingerprint } = generateSshKeyPair();
    log(`SSH 키 생성 완료: ${fingerprint}`);

    // Proxmox DB에 SSH 키 저장
    const keyVersion = `deploy-${task.jobId.slice(0, 8)}`;
    await prisma.key.upsert({
      where: { fingerprint },
      update: {},
      create: {
        fingerprint,
        keyVersion,
        publicKey,
        privateKeyEnc: encryptText(privateKey),
      },
    });
    await updateTask(taskId, { keyFingerprint: fingerprint });

    // ─── 2. Cloud Image 확인 (cloud-image 모드) ───
    let cloudImageVolid: string | null = task.cloudImageVolid || null;
    if (task.vmSource === "cloud-image") {
      await updateTask(taskId, { currentStep: "Cloud Image 확인 중..." });
      let cloudImageSourceStorage = task.storagePool;
      const storages = await client.getStoragePools(task.node);
      if (storages.ok && Array.isArray(storages.data)) {
        const importStorage = storages.data.find((s) =>
          String(s.content || "")
            .split(",")
            .map((v) => v.trim())
            .includes("import")
        );
        if (importStorage?.storage) {
          cloudImageSourceStorage = importStorage.storage;
        }
      }

      // 잘못 전달된 값 보정:
      // - import/... 형태(스토리지 prefix 없음): <storage>:import/... 로 보정
      if (cloudImageVolid) {
        const normalized = String(cloudImageVolid).trim();
        if (!normalized) {
          cloudImageVolid = null;
        } else if (!normalized.includes(":") && normalized.startsWith("import/")) {
          cloudImageVolid = `${cloudImageSourceStorage}:${normalized}`;
        } else {
          cloudImageVolid = normalized;
        }
      }

      if (!cloudImageVolid) {
        throw new Error(
          "Cloud Image가 선택되지 않았습니다. 오프라인 환경 정책상 자동 다운로드는 지원하지 않습니다."
        );
      }
      if (cloudImageVolid.includes(":iso/")) {
        log(
          `선택된 Cloud Image가 iso 콘텐츠입니다 (${cloudImageVolid}). import-from 호환을 위해 import 콘텐츠(local:import/...) 파일을 선택하세요.`
        );
      }
      if (!cloudImageVolid.includes(":")) {
        throw new Error(
          `잘못된 Cloud Image 값입니다: '${cloudImageVolid}'. ` +
            `형식은 'storage:import/<file>' 이어야 합니다.`
        );
      }
      const parsed = parseVolid(cloudImageVolid);
      if (!parsed) {
        throw new Error(`잘못된 Cloud Image volid 형식입니다: '${cloudImageVolid}'`);
      }
      await waitForImportImageVisible(client, task.node, parsed.storage, cloudImageVolid, 30000);
      log(`Cloud Image 준비 완료 (사용자 선택: ${cloudImageVolid})`);
    }

    // ─── Cloud-init snippet 스토리지 탐색 ───
    let snippetStorage = "local";
    const storageRes = await client.getStoragePools(task.node);
    if (storageRes.ok && Array.isArray(storageRes.data)) {
      const snippetCapable = storageRes.data.find((s) =>
        String(s.content || "")
          .split(",")
          .map((v) => v.trim())
          .includes("snippets")
      );
      if (snippetCapable?.storage) {
        snippetStorage = snippetCapable.storage;
      }
    }
    log(`Cloud-init snippet storage: ${snippetStorage}`);

    // ─── 3. VM 순차 생성 ───
    let completedVms = 0;
    let failedVms = 0;
    const createdVmList: Array<{ vmid: number; hostname: string; ip: string }> = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const hostnameBase = normalizeHostnameBase(task.hostnamePrefix);
    const usedHostnameNumbers = new Set<number>();

    // IP 충돌 방지: DB에서 이미 사용 중인 IP 수집
    const usedIps = new Set<string>();
    const existingVmsWithIp = await prisma.vm.findMany({
      where: { ip: { not: null } },
      select: { ip: true },
    });
    for (const vm of existingVmsWithIp) {
      if (vm.ip) usedIps.add(vm.ip);
    }

    const dbVms = await prisma.vm.findMany({
      where: { hostname: { startsWith: `${hostnameBase}-` } },
      select: { hostname: true },
    });
    const hostnameRegex = new RegExp(`^${escapeRegex(hostnameBase)}-(\\d+)$`);
    for (const vm of dbVms) {
      const match = hostnameRegex.exec(vm.hostname || "");
      if (!match) continue;
      const parsed = parseInt(match[1], 10);
      if (!Number.isNaN(parsed)) usedHostnameNumbers.add(parsed);
    }

    const clusterRes = await client.getClusterResources("vm");
    if (clusterRes.ok && Array.isArray(clusterRes.data)) {
      for (const r of clusterRes.data) {
        const name = String((r as any)?.name || "");
        const match = hostnameRegex.exec(name);
        if (!match) continue;
        const parsed = parseInt(match[1], 10);
        if (!Number.isNaN(parsed)) usedHostnameNumbers.add(parsed);
      }
    }

    let nextHostnameNumber = Math.max(1, parseInt(String(task.startNumber || 1), 10) || 1);
    while (usedHostnameNumbers.has(nextHostnameNumber)) {
      nextHostnameNumber++;
    }

    const isVmidConflictError = (msg: string): boolean =>
      /(vmid\s*\d+.*already exists|already exists in cluster|already defined|already used)/i.test(
        msg
      );

    let nextIpOffset = 0;

    for (let i = 0; i < task.vmCount; i++) {
      // 취소 확인
      const current = await prisma.deployTask.findUnique({ where: { id: taskId } });
      if (current?.status === "CANCELLED") {
        log("사용자에 의해 취소됨");
        return;
      }

      let vmid = await client.findNextAvailableVmid(task.startVmid + i);

      // Hostname 충돌 방지: DB를 실시간 재조회하여 중복 확인
      const freshDbVms = await prisma.vm.findMany({
        where: { hostname: { startsWith: `${hostnameBase}-` }, deletedAt: null },
        select: { hostname: true },
      });
      for (const fv of freshDbVms) {
        const m = hostnameRegex.exec(fv.hostname || "");
        if (m) {
          const n = parseInt(m[1], 10);
          if (!Number.isNaN(n)) usedHostnameNumbers.add(n);
        }
      }
      while (usedHostnameNumbers.has(nextHostnameNumber)) {
        nextHostnameNumber++;
      }

      const currentHostnameNumber = nextHostnameNumber;
      const num = String(currentHostnameNumber).padStart(2, "0");
      const hostname = `${hostnameBase}-${num}`;

      // IP 충돌 방지: DB에서 이미 사용 중인 IP는 건너뜀
      let ip = incrementIp(task.startIp, nextIpOffset);
      while (usedIps.has(ip)) {
        log(`IP ${ip} 이미 사용 중, 건너뜀`);
        nextIpOffset++;
        ip = incrementIp(task.startIp, nextIpOffset);
      }
      usedIps.add(ip);
      nextIpOffset++;
      const stepMsg = `VM ${i + 1}/${task.vmCount} 생성 중... (${hostname}, VMID: ${vmid})`;
      usedHostnameNumbers.add(currentHostnameNumber);
      nextHostnameNumber = currentHostnameNumber + 1;
      while (usedHostnameNumbers.has(nextHostnameNumber)) {
        nextHostnameNumber++;
      }

      await updateTask(taskId, {
        currentStep: stepMsg,
        progress: Math.round((i / task.vmCount) * 80), // 0~80%는 VM 생성
      });

      log(stepMsg);

      try {
        const MAX_VMID_RETRY = 20;
        let vmCreated = false;
        let lastErr: any = null;
        for (let attempt = 0; attempt < MAX_VMID_RETRY; attempt++) {
          // VMID 충돌 검사
          const exists = await client.checkVmidExists(vmid);
          if (exists) {
            const next = await client.findNextAvailableVmid(vmid + 1);
            log(`VMID ${vmid} 충돌 감지, 다음 VMID ${next}로 재시도`);
            vmid = next;
            continue;
          }

          try {
            if (task.vmSource === "cloud-image") {
              await createVmFromCloudImage(
                client,
                task,
                vmid,
                hostname,
                ip,
                publicKey,
                cloudImageVolid
              );
            } else {
              await createVmFromTemplate(client, task, vmid, hostname, ip, publicKey);
            }
            vmCreated = true;
            break;
          } catch (createErr: any) {
            const errMsg = String(createErr?.message || createErr || "");
            lastErr = createErr;

            if (isVmidConflictError(errMsg)) {
              const next = await client.findNextAvailableVmid(vmid + 1);
              log(`VMID ${vmid} 생성 중 충돌, 다음 VMID ${next}로 재시도`);
              vmid = next;
              continue;
            }

            throw createErr;
          }
        }

        if (!vmCreated) {
          throw (
            lastErr ||
            new Error(`Unable to allocate available VMID after retries (start: ${task.startVmid})`)
          );
        }

        // Cloud-init vendor-data 적용 (qemu-guest-agent, SSH 포트, UFW, 디스크 마운트, 리부트)
        const customResult = await client.configureVm(task.node, vmid, {
          cicustom: `vendor=${snippetStorage}:snippets/${PREDEFINED_CLOUDINIT_SNIPPET_FILE}`,
        });
        if (!customResult.ok) {
          throw new Error(
            `Cloud-init snippet(cicustom) 설정 실패: ${customResult.error}. ` +
              `Proxmox ${snippetStorage}:snippets/${PREDEFINED_CLOUDINIT_SNIPPET_FILE} 파일 존재 여부를 확인하세요.`
          );
        }

        // IP 및 기본 cloud-init 설정 (snippet 실패 시에도 기본 설정은 적용)
        const nameservers = [task.dnsPrimary, task.dnsSecondary]
          .filter((v: any) => !!v && String(v).trim().length > 0)
          .map((v: any) => String(v).trim())
          .join(" ");
        await client.configureVm(task.node, vmid, {
          ipconfig0: `ip=${ip}/24,gw=${task.gatewayIp}`,
          nameserver: nameservers || task.gatewayIp,
          searchdomain: "local",
          ciuser: task.vmUser,
          cipassword: DEFAULT_VM_PASSWORD,
          sshkeys: encodeURIComponent(publicKey),
        });

        // VM 시작
        const startResult = await client.startVm(task.node, vmid);
        if (!startResult.ok) {
          throw new Error(`VM start failed: ${startResult.error}`);
        }
        if (startResult.data) {
          await client.waitForTask(task.node, startResult.data, 120000);
        }
        await ensureVmRunning(client, task.node, vmid);

        createdVmList.push({ vmid, hostname, ip });
        completedVms++;
        log(`✅ ${hostname} (VMID: ${vmid}, IP: ${ip}) 생성 완료`);
      } catch (vmErr: any) {
        failedVms++;
        const errMsg = `❌ ${hostname} (VMID: ${vmid}): ${vmErr.message}`;
        errors.push(errMsg);
        log(errMsg);

        // 실패한 VM을 Proxmox에서 정리 (반쯤 생성된 찌꺼기 방지)
        try {
          const stopRes = await client.stopVm(task.node, vmid);
          if (stopRes.ok && stopRes.data) {
            await client.waitForTask(task.node, stopRes.data, 30000).catch(() => {});
          }
          await client.deleteVm(task.node, vmid);
          log(`🧹 실패한 VM ${vmid} Proxmox에서 정리 완료`);
        } catch (cleanupErr: any) {
          log(`⚠️ 실패한 VM ${vmid} 정리 실패 (수동 확인 필요): ${cleanupErr.message}`);
        }
      }

      await updateTask(taskId, { completedVms, failedVms });
    }

    // ─── 4. Proxmox Job/VM 등록 ───
    await updateTask(taskId, {
      currentStep: "Proxmox 등록 중...",
      progress: 85,
    });

    // Job 등록 (재시도 시 기존 Job 재사용)
    const group = await prisma.group.findUnique({ where: { id: task.groupId } });
    let job;
    if (existingJobId) {
      // 기존 Job의 vmCount를 새로 생성된 VM 수만큼 증가
      job = await prisma.job.update({
        where: { jobId: existingJobId },
        data: { vmCount: { increment: completedVms } },
      });
      log(`기존 Job ${existingJobId} 업데이트: vmCount +${completedVms}`);
    } else {
      job = await prisma.job.create({
        data: {
          jobId: task.jobId,
          groupId: task.groupId,
          node: task.node,
          template: task.templateName,
          vmCount: completedVms,
          storagePool: task.storagePool,
          networkBridge: task.networkBridge,
          keyFingerprint: fingerprint,
        },
      });
    }

    // VM 등록 (리소스 정보 포함 - 할당량 계산용)
    for (const vm of createdVmList) {
      // 디스크 구성: scsi0 = 부팅 디스크, scsi1..N = 추가 디스크 (동일 크기)
      const diskEntries: Array<{ slot: string; sizeGb: number; storage: string }> = [
        { slot: "scsi0", sizeGb: task.diskSizeGb, storage: task.storagePool },
      ];
      for (let i = 0; i < task.extraDiskCount; i++) {
        diskEntries.push({ slot: `scsi${i + 1}`, sizeGb: task.extraDiskGb, storage: task.storagePool });
      }
      const totalDiskGb = task.diskSizeGb + task.extraDiskGb * task.extraDiskCount;

      await prisma.vm.create({
        data: {
          groupId: task.groupId,
          jobId: task.jobId,
          node: task.node,
          vmid: vm.vmid,
          hostname: vm.hostname,
          ip: vm.ip,
          cpuCores: task.cpuCores,
          memoryMb: task.memoryMb,
          diskSizeGb: totalDiskGb,
          // 배포 직후 자동 교체가 즉시 실행되지 않도록 기준 시각을 현재로 설정
          lastRotatedAt: new Date(),
          disks: {
            create: diskEntries,
          },
        },
      });
    }
    log(`Proxmox 등록 완료: Job ${task.jobId}, VMs ${createdVmList.length}개`);

    // ─── 5. 감사 로그 ───
    await updateTask(taskId, { currentStep: "감사 로그 기록 중...", progress: 95 });

    const vmSummary = createdVmList
      .slice(0, 10)
      .map((vm) => `${vm.hostname}(VMID:${vm.vmid}, IP:${vm.ip})`)
      .join(", ");
    const hasMoreVms = createdVmList.length > 10;
    const failSummary = errors
      .slice(0, 3)
      .map((e) => e.replace(/^❌\s*/, ""))
      .join(" | ");
    const hasMoreFails = errors.length > 3;

    const deploySummary =
      `${completedVms}/${task.vmCount} VMs created on ${task.node}` +
      (vmSummary ? ` | ${vmSummary}${hasMoreVms ? ", ..." : ""}` : "") +
      (failSummary ? ` | FAIL: ${failSummary}${hasMoreFails ? " | ..." : ""}` : "") +
      (warnings.length > 0 ? ` | WARN: ${warnings.slice(0, 2).join(" | ")}${warnings.length > 2 ? " | ..." : ""}` : "");

    // ─── 6. 완료 ───
    const finalStatus = failedVms === 0 ? "COMPLETED" : failedVms === task.vmCount ? "FAILED" : "PARTIAL";

    const auditAction = finalStatus === "FAILED" ? "DEPLOY_FAILED" : finalStatus === "PARTIAL" ? "DEPLOY_PARTIAL" : "DEPLOY_COMPLETED";
    const auditResult = finalStatus === "FAILED" ? "FAIL" : finalStatus === "PARTIAL" ? "PARTIAL" : "SUCCESS";
    await writeAudit({
      userId: task.createdBy,
      action: auditAction,
      result: auditResult,
      reason: deploySummary,
      groupId: task.groupId,
      jobId: task.jobId,
      fingerprint,
    });
    await updateTask(taskId, {
      status: finalStatus,
      progress: 100,
      currentStep:
        finalStatus === "COMPLETED"
          ? warnings.length > 0
            ? `✅ ${completedVms}개 VM 생성 완료 (경고 ${warnings.length}건)`
            : `✅ ${completedVms}개 VM 생성 완료`
          : `⚠️ ${completedVms}개 성공, ${failedVms}개 실패`,
      errorLog:
        errors.length > 0 || warnings.length > 0
          ? [...errors, ...warnings].join("\n")
          : null,
    });

    // ─── 7. VmRequest 상태 동기화 ───
    await syncVmRequestStatus(taskId, finalStatus);

    log(`배포 완료: ${finalStatus}`);
  } catch (err: any) {
    log(`배포 실패: ${err.message}`);
    await updateTask(taskId, {
      status: "FAILED",
      currentStep: `❌ 배포 실패: ${err.message}`,
      errorLog: err.stack || err.message,
    });
    await syncVmRequestStatus(taskId, "FAILED");
  }
}


// ─── 헬퍼 함수들 ───

/**
 * DeployTask와 연결된 VmRequest의 상태를 동기화합니다.
 */
async function syncVmRequestStatus(taskId: string, status: string) {
  try {
    const vmRequest = await prisma.vmRequest.findFirst({
      where: { deployTaskId: taskId },
    });
    if (vmRequest) {
      await prisma.vmRequest.update({
        where: { id: vmRequest.id },
        data: { status },
      });
    }
  } catch (e) {
    console.error(`[Deploy] VmRequest sync failed for task ${taskId}:`, e);
  }
}

async function updateTask(taskId: string, data: any) {
  await prisma.deployTask.update({ where: { id: taskId }, data });
}

async function ensureVmRunning(
  client: ProxmoxClient,
  node: string,
  vmid: number,
  maxAttempts: number = 12
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await client.getVmStatus(node, vmid);
    if (status.ok && String(status.data?.status || "").toLowerCase() === "running") {
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`VM ${vmid} did not reach running state`);
}

/**
 * Cloud Image 기반 VM 생성
 */
async function createVmFromCloudImage(
  client: ProxmoxClient,
  task: any,
  vmid: number,
  hostname: string,
  ip: string,
  publicKey: string,
  cloudImageVolid: string | null
): Promise<void> {
  if (!cloudImageVolid) {
    throw new Error("Cloud image source volid not found");
  }

  // 1. VM 생성 (빈 VM)
  const createResult = await client.createVm(task.node, vmid, {
    name: hostname,
    memory: task.memoryMb,
    cores: task.cpuCores,
    cpu: "host",
    agent: 1,
    ostype: "l26",
    scsihw: "virtio-scsi-single",
    boot: "order=scsi0",
    net0: `virtio,bridge=${task.networkBridge}`,
    serial0: "socket",
    vga: "serial0",
  });

  if (!createResult.ok) {
    throw new Error(`VM creation failed: ${createResult.error}`);
  }
  if (createResult.data) {
    await client.waitForTask(task.node, createResult.data, 120000);
  }

  // 2. Cloud Image 디스크를 VM에 import (API로 직접 불가 → scsi0 설정으로 대체)
  // Proxmox API에서는 importdisk가 직접 지원되지 않으므로
  // 이미 다운로드된 이미지를 scsi0로 설정
  const importResult = await client.configureVm(task.node, vmid, {
    scsi0: `${task.storagePool}:0,import-from=${cloudImageVolid},discard=on`,
  });
  if (!importResult.ok) {
    throw new Error(`Cloud image import config failed: ${importResult.error}`);
  }

  // 3. 디스크 리사이즈
  await resizePrimaryDisk(client, task.node, vmid, `${task.diskSizeGb}G`, "scsi0");

  // 4. Cloud-init 드라이브 추가
  const ciDriveResult = await client.configureVm(task.node, vmid, {
    ide2: `${task.storagePool}:cloudinit`,
  });
  if (!ciDriveResult.ok) {
    throw new Error(`Cloud-init drive attach failed: ${ciDriveResult.error}`);
  }

  // 5. 추가 디스크
  for (let d = 0; d < task.extraDiskCount; d++) {
    const diskKey = `scsi${d + 1}`;
    const extraDiskResult = await client.configureVm(task.node, vmid, {
      [diskKey]: `${task.storagePool}:${task.extraDiskGb},format=raw,discard=on`,
    });
    if (!extraDiskResult.ok) {
      throw new Error(`Extra disk attach failed (${diskKey}): ${extraDiskResult.error}`);
    }
  }
}

/**
 * 템플릿 Clone 기반 VM 생성
 */
async function createVmFromTemplate(
  client: ProxmoxClient,
  task: any,
  vmid: number,
  hostname: string,
  ip: string,
  publicKey: string
): Promise<void> {
  if (!task.sourceTemplateVmid) {
    throw new Error("Template VMID not specified");
  }

  // 1. 클론
  const cloneResult = await client.cloneVm(
    task.node,
    task.sourceTemplateVmid,
    vmid,
    {
      name: hostname,
      full: 1,
      storage: task.storagePool,
    }
  );

  if (!cloneResult.ok) {
    throw new Error(`Clone failed: ${cloneResult.error}`);
  }
  if (cloneResult.data) {
    // 클론은 시간이 오래 걸릴 수 있음
    await client.waitForTask(task.node, cloneResult.data, 600000);
  }

  // 2. 리소스 설정
  const resourceResult = await client.configureVm(task.node, vmid, {
    memory: task.memoryMb,
    cores: task.cpuCores,
    agent: 1,
  });
  if (!resourceResult.ok) {
    throw new Error(`VM resource config failed: ${resourceResult.error}`);
  }

  // 3. 디스크 리사이즈
  await resizePrimaryDisk(client, task.node, vmid, `${task.diskSizeGb}G`);

  // 4. 추가 디스크
  for (let d = 0; d < task.extraDiskCount; d++) {
    const diskKey = `scsi${d + 1}`;
    const extraDiskResult = await client.configureVm(task.node, vmid, {
      [diskKey]: `${task.storagePool}:${task.extraDiskGb},format=raw,discard=on`,
    });
    if (!extraDiskResult.ok) {
      throw new Error(`Extra disk attach failed (${diskKey}): ${extraDiskResult.error}`);
    }
  }
}

async function resolvePrimaryDiskKey(
  client: ProxmoxClient,
  node: string,
  vmid: number,
  preferred?: string
): Promise<string> {
  const cfgRes = await client.getVmConfig(node, vmid);
  const cfg: Record<string, any> = cfgRes.ok && cfgRes.data ? (cfgRes.data as Record<string, any>) : {};

  if (preferred && cfg[preferred]) return preferred;

  const candidates = ["scsi0", "virtio0", "sata0", "ide0"];
  for (const key of candidates) {
    const value = String(cfg[key] || "");
    if (!value) continue;
    if (value.toLowerCase().includes("cloudinit")) continue;
    return key;
  }

  const bootOrder = String(cfg.boot || "");
  const match = bootOrder.match(/(scsi|virtio|sata|ide)\d+/i);
  if (match) return match[0].toLowerCase();

  return preferred || "scsi0";
}

async function resizePrimaryDisk(
  client: ProxmoxClient,
  node: string,
  vmid: number,
  size: string,
  preferred?: string
): Promise<void> {
  const diskKey = await resolvePrimaryDiskKey(client, node, vmid, preferred);
  const resizeResult = await client.resizeDisk(node, vmid, diskKey, size);
  if (!resizeResult.ok) {
    throw new Error(`Disk resize failed (${diskKey}): ${resizeResult.error}`);
  }
}

/**
 * SSH 키쌍 생성 (RSA 4096-bit)
 * Node.js crypto 모듈 사용
 */
function generateSshKeyPair(): {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
} {
  const { publicKey: pubPem, privateKey: privPem } = crypto.generateKeyPairSync(
    "rsa",
    {
      modulusLength: 4096,
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    }
  );

  // PEM → OpenSSH public key 형식 변환
  const pubKeyObj = crypto.createPublicKey(pubPem);
  const sshPub = pubKeyObj
    .export({ type: "spki", format: "der" })
    .toString("base64");

  // RSA 공개키 DER → OpenSSH 형식으로 직접 인코딩
  const pubDer = pubKeyObj.export({ type: "pkcs1", format: "der" });
  const sshPublicKey = `ssh-rsa ${derToOpenSshRsa(pubDer)} vm-automation`;

  // 핑거프린트 (SHA256)
  const fpHash = crypto
    .createHash("sha256")
    .update(Buffer.from(derToOpenSshRsa(pubDer), "base64"))
    .digest("base64")
    .replace(/=+$/, "");
  const fingerprint = `SHA256:${fpHash}`;

  return {
    publicKey: sshPublicKey,
    privateKey: privPem,
    fingerprint,
  };
}

/**
 * RSA PKCS#1 DER → OpenSSH wire format base64
 */
function derToOpenSshRsa(derBuf: Buffer): string {
  // PKCS#1 DER에서 n, e 추출 (간이 ASN.1 파서)
  const key = crypto.createPublicKey({
    key: derBuf,
    format: "der",
    type: "pkcs1",
  });
  const jwk = key.export({ format: "jwk" });
  const e = Buffer.from(jwk.e as string, "base64url");
  const n = Buffer.from(jwk.n as string, "base64url");

  // OpenSSH wire format: string "ssh-rsa" + mpint e + mpint n
  const typeStr = Buffer.from("ssh-rsa");
  const parts = [typeStr, e, n];

  let totalLen = 0;
  const encoded = parts.map((p) => {
    // 음수 방지를 위해 앞에 0x00 패딩
    let buf = p;
    if (buf[0] & 0x80) {
      buf = Buffer.concat([Buffer.from([0x00]), buf]);
    }
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(buf.length);
    totalLen += 4 + buf.length;
    return Buffer.concat([lenBuf, buf]);
  });

  return Buffer.concat(encoded).toString("base64");
}
