/**
 * VM 생성 요청 API (일반 사용자용)
 * 사용자가 대시보드에서 VM 생성을 요청하고 상태를 조회합니다.
 */

import { Router } from "express";
import { prisma } from "../../services/prisma";
import { requireLogin } from "../middlewares/requireLogin";
import { getGroupQuotaUsage, checkQuotaExceeded } from "../../services/quotaService";
import { writeAudit } from "../../services/audit";
import { getClientIp } from "../../utils/requestIp";

export const vmRequestsApi = Router();

// 로그인만 필요 (관리자 권한 불필요)
vmRequestsApi.use(requireLogin);

/**
 * GET /api/vm-requests/instance-types
 * Instance Type 목록 (DeployTemplate 조회)
 */
vmRequestsApi.get("/instance-types", async (req, res) => {
  try {
    const templates = await prisma.deployTemplate.findMany({
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        cpuCores: true,
        memoryMb: true,
        diskSizeGb: true,
        extraDiskGb: true,
        extraDiskCount: true,
        description: true,
      },
    });
    res.json({ ok: true, templates });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/vm-requests/quota/:groupId
 * 그룹 할당량 조회 (소속 그룹만)
 */
vmRequestsApi.get("/quota/:groupId", async (req, res) => {
  const { groupId } = req.params;
  const userId = req.user!.id;

  try {
    // 그룹 소속 확인
    const membership = await prisma.groupMembership.findFirst({
      where: { userId, groupId },
    });
    if (!membership && !(req.user as any).isAdmin) {
      return res.status(403).json({ error: "NOT_GROUP_MEMBER" });
    }

    const usage = await getGroupQuotaUsage(groupId);
    res.json({ ok: true, ...usage });
  } catch (e: any) {
    if (e.code === "P2025") {
      return res.status(404).json({ error: "GROUP_NOT_FOUND" });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/vm-requests
 * 내 그룹의 요청 목록
 */
vmRequestsApi.get("/", async (req, res) => {
  const userId = req.user!.id;
  const isAdmin = (req.user as any).isAdmin;

  try {
    // 내 그룹 ID 목록
    const memberships = await prisma.groupMembership.findMany({
      where: { userId },
      select: { groupId: true },
    });
    const myGroupIds = memberships.map((m) => m.groupId);

    const requests = await prisma.vmRequest.findMany({
      where: isAdmin ? {} : { groupId: { in: myGroupIds } },
      include: {
        group: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ ok: true, requests });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/vm-requests
 * VM 요청 제출
 */
vmRequestsApi.post("/", async (req, res) => {
  const userId = req.user!.id;
  const {
    groupId,
    instanceType,
    vmCount,
    purpose,
    cpuCores,
    memoryMb,
    diskSizeGb,
    extraDiskGb,
    extraDiskCount,
    preferredOs,
  } = req.body;

  // 필수 필드 검증
  if (!groupId || !instanceType || !vmCount || !cpuCores || !memoryMb || !diskSizeGb) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  try {
    // 그룹 소속 확인
    const membership = await prisma.groupMembership.findFirst({
      where: { userId, groupId },
    });
    if (!membership && !(req.user as any).isAdmin) {
      return res.status(403).json({ error: "NOT_GROUP_MEMBER" });
    }

    // 그룹 정보 조회하여 자동 hostname 생성
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) {
      return res.status(404).json({ error: "GROUP_NOT_FOUND" });
    }

    // Hostname prefix 자동 생성: 그룹명을 소문자로 변환 (예: "NEXUS" -> "nexus")
    const hostnamePrefix = group.name.toLowerCase();

    // 할당량 체크
    const totalDiskPerVm = diskSizeGb + (extraDiskGb || 0) * (extraDiskCount || 0);
    const exceeded = await checkQuotaExceeded(
      groupId,
      cpuCores,
      memoryMb,
      totalDiskPerVm,
      vmCount
    );

    const status = exceeded.length > 0 ? "QUOTA_EXCEEDED" : "REQUESTED";

    const request = await prisma.vmRequest.create({
      data: {
        groupId,
        instanceType,
        vmCount: parseInt(String(vmCount)),
        hostnamePrefix,
        purpose: purpose || null,
        cpuCores: parseInt(String(cpuCores)),
        memoryMb: parseInt(String(memoryMb)),
        diskSizeGb: parseInt(String(diskSizeGb)),
        extraDiskGb: parseInt(String(extraDiskGb || 0)),
        extraDiskCount: parseInt(String(extraDiskCount || 0)),
        preferredOs: preferredOs || null,
        requestedBy: userId,
        status,
      },
    });

    await writeAudit({
      userId,
      action: "VM_REQUEST_CREATE",
      result: "SUCCESS",
      groupId,
      reason: `VM request: ${instanceType} x${vmCount} (${hostnamePrefix}), status: ${status}${exceeded.length > 0 ? `, exceeded: ${exceeded.join(",")}` : ""}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({
      ok: true,
      request,
      quotaExceeded: exceeded.length > 0,
      exceededResources: exceeded,
    });
  } catch (e: any) {
    console.error("[VmRequest] Create error:", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/vm-requests/:id/cancel
 * 요청 취소 (REQUESTED 또는 QUOTA_EXCEEDED 상태만)
 */
vmRequestsApi.delete("/:id/cancel", async (req, res) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const request = await prisma.vmRequest.findUnique({ where: { id } });
    if (!request) {
      return res.status(404).json({ error: "REQUEST_NOT_FOUND" });
    }

    // 본인 요청인지 확인 (관리자는 모두 취소 가능)
    if (request.requestedBy !== userId && !(req.user as any).isAdmin) {
      return res.status(403).json({ error: "NOT_REQUEST_OWNER" });
    }

    if (!["REQUESTED", "QUOTA_EXCEEDED"].includes(request.status)) {
      return res.status(400).json({ error: "CANNOT_CANCEL", message: `Current status: ${request.status}` });
    }

    await prisma.vmRequest.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    await writeAudit({
      userId,
      action: "VM_REQUEST_CANCEL",
      result: "SUCCESS",
      groupId: request.groupId,
      reason: `Cancelled VM request: ${request.instanceType} x${request.vmCount}`,
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || "",
    });

    res.json({ ok: true });
  } catch (e: any) {
    console.error("[VmRequest] Cancel error:", e);
    res.status(500).json({ error: e.message });
  }
});
