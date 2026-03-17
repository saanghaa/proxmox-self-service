import { prisma } from "./prisma";

export interface QuotaUsage {
  groupId: string;
  groupName: string;
  quota: {
    maxCpuCores: number;
    maxMemoryMb: number;
    maxDiskGb: number;
    maxVmCount: number;
  };
  used: {
    cpuCores: number;
    memoryMb: number;
    diskGb: number;
    vmCount: number;
  };
  pending: {
    cpuCores: number;
    memoryMb: number;
    diskGb: number;
    vmCount: number;
  };
  available: {
    cpuCores: number;
    memoryMb: number;
    diskGb: number;
    vmCount: number;
  };
}

/**
 * 그룹의 할당량/사용량/대기량/잔여량을 계산합니다.
 * - used: 현재 활성 VM (deletedAt IS NULL)의 리소스 합계
 * - pending: 진행 중인 VmRequest (REQUESTED, APPROVED, DEPLOYING)의 리소스 합계
 * - available: quota - used - pending (-1은 무제한)
 */
export async function getGroupQuotaUsage(groupId: string): Promise<QuotaUsage> {
  const group = await prisma.group.findUniqueOrThrow({
    where: { id: groupId },
    include: { quota: true },
  });

  const quota = group.quota ?? {
    maxCpuCores: -1,
    maxMemoryMb: -1,
    maxDiskGb: -1,
    maxVmCount: -1,
  };

  // 현재 활성 VM 리소스 합계
  const activeVms = await prisma.vm.findMany({
    where: { groupId, deletedAt: null },
    select: { cpuCores: true, memoryMb: true, diskSizeGb: true },
  });

  const used = {
    cpuCores: activeVms.reduce((sum, vm) => sum + (vm.cpuCores ?? 0), 0),
    memoryMb: activeVms.reduce((sum, vm) => sum + (vm.memoryMb ?? 0), 0),
    diskGb: activeVms.reduce((sum, vm) => sum + (vm.diskSizeGb ?? 0), 0),
    vmCount: activeVms.length,
  };

  // 진행 중인 요청 리소스 합계
  const pendingRequests = await prisma.vmRequest.findMany({
    where: {
      groupId,
      status: { in: ["REQUESTED", "APPROVED", "DEPLOYING"] },
    },
    select: {
      cpuCores: true,
      memoryMb: true,
      diskSizeGb: true,
      extraDiskGb: true,
      extraDiskCount: true,
      vmCount: true,
    },
  });

  const pending = {
    cpuCores: pendingRequests.reduce((sum, r) => sum + r.cpuCores * r.vmCount, 0),
    memoryMb: pendingRequests.reduce((sum, r) => sum + r.memoryMb * r.vmCount, 0),
    diskGb: pendingRequests.reduce(
      (sum, r) => sum + (r.diskSizeGb + r.extraDiskGb * r.extraDiskCount) * r.vmCount,
      0
    ),
    vmCount: pendingRequests.reduce((sum, r) => sum + r.vmCount, 0),
  };

  // 잔여량 계산 (-1이면 무제한 → Infinity)
  const calcAvailable = (max: number, usedVal: number, pendingVal: number) =>
    max === -1 ? -1 : Math.max(0, max - usedVal - pendingVal);

  const available = {
    cpuCores: calcAvailable(quota.maxCpuCores, used.cpuCores, pending.cpuCores),
    memoryMb: calcAvailable(quota.maxMemoryMb, used.memoryMb, pending.memoryMb),
    diskGb: calcAvailable(quota.maxDiskGb, used.diskGb, pending.diskGb),
    vmCount: calcAvailable(quota.maxVmCount, used.vmCount, pending.vmCount),
  };

  return {
    groupId,
    groupName: group.name,
    quota: {
      maxCpuCores: quota.maxCpuCores,
      maxMemoryMb: quota.maxMemoryMb,
      maxDiskGb: quota.maxDiskGb,
      maxVmCount: quota.maxVmCount,
    },
    used,
    pending,
    available,
  };
}

/**
 * 요청이 그룹 할당량 내에 있는지 확인합니다.
 * 초과하는 리소스 항목 목록을 반환합니다 (빈 배열이면 OK).
 */
export async function checkQuotaExceeded(
  groupId: string,
  requestCpuCores: number,
  requestMemoryMb: number,
  requestDiskGb: number,
  requestVmCount: number
): Promise<string[]> {
  const usage = await getGroupQuotaUsage(groupId);
  const exceeded: string[] = [];

  const check = (label: string, max: number, usedVal: number, pendingVal: number, request: number) => {
    if (max !== -1 && usedVal + pendingVal + request > max) {
      exceeded.push(label);
    }
  };

  check("CPU", usage.quota.maxCpuCores, usage.used.cpuCores, usage.pending.cpuCores, requestCpuCores * requestVmCount);
  check("Memory", usage.quota.maxMemoryMb, usage.used.memoryMb, usage.pending.memoryMb, requestMemoryMb * requestVmCount);
  check("Disk", usage.quota.maxDiskGb, usage.used.diskGb, usage.pending.diskGb, requestDiskGb * requestVmCount);
  check("VM Count", usage.quota.maxVmCount, usage.used.vmCount, usage.pending.vmCount, requestVmCount);

  return exceeded;
}
