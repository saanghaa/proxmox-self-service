/**
 * VM 상태 동기화 서비스
 * Proxmox 노드들을 주기적으로 폴링하여 VM 상태를 DB에 반영합니다.
 */

import { prisma } from "./prisma";
import { ProxmoxClient } from "./proxmox";
import { decryptText } from "./crypto";

let syncInterval: NodeJS.Timeout | null = null;
const SYNC_INTERVAL_MS = 3 * 60 * 1000; // 3분

/** Proxmox config 값에서 디스크 크기(GB) 파싱: "size=100G" → 100, "size=512M" → 0 (무시) */
function parseDiskSizeGb(configValue: string): number | null {
  const sizeMatch = configValue.match(/size=(\d+)([GMK])/i);
  if (!sizeMatch) return null;
  const num = parseInt(sizeMatch[1], 10);
  const unit = sizeMatch[2].toUpperCase();
  if (unit === "G") return num;
  if (unit === "T") return num * 1024;
  // M, K는 1GB 미만이라 디스크 슬롯으로 무시
  return null;
}

/** Proxmox config 값에서 스토리지 이름 파싱: "pve-pool:vm-200-disk-1,..." → "pve-pool" */
function parseDiskStorage(configValue: string): string | null {
  const colonIdx = configValue.indexOf(":");
  if (colonIdx < 0) return null;
  return configValue.substring(0, colonIdx);
}

const DISK_SLOT_RE = /^(scsi|virtio|sata|ide)\d+$/;

/**
 * 동기화 서비스 시작
 */
export function startVmSyncService(): void {
  console.log("[VmSync] 상태 동기화 서비스 시작 (주기: 3분)");

  // 서버 시작 후 10초 뒤 첫 동기화
  setTimeout(() => {
    syncAllVmStatuses().catch((e) =>
      console.error("[VmSync] 초기 동기화 실패:", e.message)
    );
  }, 10000);

  // 주기적 동기화
  syncInterval = setInterval(() => {
    syncAllVmStatuses().catch((e) =>
      console.error("[VmSync] 동기화 실패:", e.message)
    );
  }, SYNC_INTERVAL_MS);
}

/**
 * 동기화 서비스 종료
 */
export function stopVmSyncService(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log("[VmSync] 상태 동기화 서비스 종료");
  }
}

/**
 * 모든 PVE 노드에서 VM 상태를 가져와 DB에 반영
 */
export async function syncAllVmStatuses(): Promise<void> {
  const pveNodes = await prisma.pveNode.findMany({
    where: { isOnline: true },
  });

  if (pveNodes.length === 0) return;

  // DB에서 활성 VM 목록 (삭제되지 않은 것들)
  const activeVms = await prisma.vm.findMany({
    where: { deletedAt: null, vmid: { not: null } },
    select: { id: true, vmid: true, node: true, groupId: true },
  });

  if (activeVms.length === 0) return;

  // vmid → DB VM id 매핑
  const vmidToDbId = new Map<number, string>();
  for (const vm of activeVms) {
    if (vm.vmid) vmidToDbId.set(vm.vmid, vm.id);
  }

  const now = new Date();
  const updates: Array<{ id: string; status: string; node: string; disks: Array<{ slot: string; sizeGb: number; storage: string | null }> }> = [];
  // Proxmox에서 확인된 vmid 집합 (노드 조회 성공한 경우만)
  const foundVmids = new Set<number>();
  // 조회 성공한 노드에 속한 DB VM id 집합
  const vmsOnSuccessfulNodes = new Set<string>();

  for (const pveNode of pveNodes) {
    try {
      const client = new ProxmoxClient(
        pveNode.host,
        pveNode.tokenId,
        decryptText(pveNode.tokenSecret)
      );

      const result = await client.getVmList(pveNode.name);
      if (!result.ok || !result.data) {
        // VM 목록 조회 실패 → 노드 오프라인 처리 및 해당 노드 VM unknown 갱신
        console.warn(`[VmSync] 노드 ${pveNode.name} VM 목록 조회 실패: ${result.error ?? 'unknown'}`);
        await prisma.pveNode.update({
          where: { id: pveNode.id },
          data: { isOnline: false, lastChecked: now },
        });
        const nodeVmIds = activeVms.filter(vm => vm.node === pveNode.name).map(vm => vm.id);
        if (nodeVmIds.length > 0) {
          await prisma.vm.updateMany({
            where: { id: { in: nodeVmIds } },
            data: { status: 'unknown', lastSyncedAt: now },
          });
        }
        continue;
      }

      // 이 노드에 속한 DB VM들을 조회 성공 목록에 추가
      for (const vm of activeVms) {
        if (vm.node === pveNode.name && vm.vmid) {
          vmsOnSuccessfulNodes.add(vm.id);
        }
      }

      for (const pveVm of result.data) {
        if (pveVm.template === 1) continue; // 템플릿 제외

        foundVmids.add(pveVm.vmid);
        const dbId = vmidToDbId.get(pveVm.vmid);
        if (!dbId) continue;

        // VM config 조회하여 디스크 슬롯 파싱
        const disks: Array<{ slot: string; sizeGb: number; storage: string | null }> = [];
        try {
          const configRes = await client.getVmConfig(pveNode.name, pveVm.vmid);
          if (configRes.ok && configRes.data) {
            for (const [key, val] of Object.entries(configRes.data)) {
              if (!DISK_SLOT_RE.test(key)) continue;
              const strVal = String(val);
              // cdrom 제외
              if (strVal.includes("media=cdrom")) continue;
              const sizeGb = parseDiskSizeGb(strVal);
              if (sizeGb === null) continue;
              disks.push({
                slot: key,
                sizeGb,
                storage: parseDiskStorage(strVal),
              });
            }
          }
        } catch {
          // config 조회 실패 시 디스크 정보 없이 상태만 업데이트
        }

        updates.push({
          id: dbId,
          status: pveVm.status,
          node: pveNode.name,
          disks,
        });
      }

      // 노드 온라인 상태 업데이트
      await prisma.pveNode.update({
        where: { id: pveNode.id },
        data: { isOnline: true, lastChecked: now },
      });
    } catch (e: any) {
      console.error(`[VmSync] 노드 ${pveNode.name} 조회 실패: ${e.message}`);
      // 노드 오프라인으로 전환 + 해당 노드 VM들을 unknown으로 보정
      await prisma.pveNode.update({
        where: { id: pveNode.id },
        data: { isOnline: false, lastChecked: now },
      });
      const nodeVmIds = activeVms.filter(vm => vm.node === pveNode.name).map(vm => vm.id);
      if (nodeVmIds.length > 0) {
        await prisma.vm.updateMany({
          where: { id: { in: nodeVmIds } },
          data: { status: 'unknown', lastSyncedAt: now },
        });
      }
    }
  }

  // 배치 업데이트: Proxmox에서 확인된 VM 상태 반영
  if (updates.length > 0) {
    for (const u of updates) {
      // 디스크 정보가 있으면 VmDisk upsert + diskSizeGb 캐시 갱신
      if (u.disks.length > 0) {
        // 기존 슬롯 삭제 후 현재 슬롯으로 교체 (슬롯 제거 감지)
        const currentSlots = u.disks.map((d) => d.slot);
        await prisma.vmDisk.deleteMany({
          where: { vmId: u.id, slot: { notIn: currentSlots } },
        });
        for (const disk of u.disks) {
          await prisma.vmDisk.upsert({
            where: { vmId_slot: { vmId: u.id, slot: disk.slot } },
            create: { vmId: u.id, slot: disk.slot, sizeGb: disk.sizeGb, storage: disk.storage },
            update: { sizeGb: disk.sizeGb, storage: disk.storage },
          });
        }
        const totalDiskGb = u.disks.reduce((s, d) => s + d.sizeGb, 0);
        await prisma.vm.update({
          where: { id: u.id },
          data: {
            status: u.status,
            node: u.node,
            diskSizeGb: totalDiskGb,
            lastSyncedAt: now,
          },
        });
      } else {
        await prisma.vm.update({
          where: { id: u.id },
          data: {
            status: u.status,
            node: u.node,
            lastSyncedAt: now,
          },
        });
      }
    }
  }

  // Proxmox에서 찾을 수 없는 VM → unknown 처리
  // (노드 조회가 성공한 경우에만, 노드 장애로 인한 오탐 방지)
  const syncedIds = new Set(updates.map((u) => u.id));
  const missingVms = activeVms.filter(
    (vm) =>
      vm.vmid &&
      !syncedIds.has(vm.id) &&
      vmsOnSuccessfulNodes.has(vm.id)
  );

  if (missingVms.length > 0) {
    console.warn(
      `[VmSync] Proxmox에서 찾을 수 없는 VM ${missingVms.length}개 → unknown 처리:`,
      missingVms.map((v) => v.vmid)
    );
    for (const vm of missingVms) {
      await prisma.vm.update({
        where: { id: vm.id },
        data: { status: "unknown", lastSyncedAt: now },
      });
    }
  }
}
