import { Router } from "express";
import { prisma } from "../services/prisma";
import { getGroupQuotaUsage } from "../services/quotaService";
import { requireLogin } from "./middlewares/requireLogin";
import { requireAdmin } from "./middlewares/requireAdmin";

export const uiRoutes = Router();

/**
 * [GET] /setup - 최초 관리자 계정 생성 페이지 (관리자 없을 때만 접근 가능)
 */
uiRoutes.get("/setup", async (req, res) => {
  try {
    const activeThemeTemplate = await prisma.systemConfig
      .findUnique({ where: { key: "theme_template" } })
      .then(cfg => cfg?.value || "proxmox")
      .catch(() => "proxmox");

    const cookieLang = (req as any).cookies?.preferred_lang;
    const currentLang = cookieLang === "en" ? "en" : "ko";

    res.render("setup", {
      activeThemeTemplate,
      currentLang,
      error: null,
    });
  } catch (error) {
    console.error("Setup Page Error:", error);
    res.status(500).send("설정 페이지를 불러오는 중 오류가 발생했습니다.");
  }
});

/**
 * [GET] / - 메인 대시보드
 * 로그인한 사용자의 그룹 기반으로 Job/VM/Key 데이터를 조회합니다.
 */
uiRoutes.get("/", requireLogin, async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = (req.user as any).isAdmin || false;

    // 1. 사용자의 그룹 멤버십 조회
    const memberships = await prisma.groupMembership.findMany({
      where: { userId },
      include: { group: true }
    });
    const groupIds = memberships.map(m => m.groupId);

    // 2. Job 목록 조회
    // Admin: 모든 Job
    // 일반 사용자: 자신의 그룹에 속한 VM이 있는 Job (Job 그룹과 VM 그룹이 다를 수 있음)
    let jobs;
    if (isAdmin) {
      jobs = await prisma.job.findMany({
        include: {
          vms: {
            where: { deletedAt: null }, // 삭제되지 않은 VM만
            include: {
              group: { select: { name: true } }
            }
          },
          key: { select: { fingerprint: true, keyVersion: true, publicKey: true } },
          group: { select: { name: true } }
        },
        orderBy: { createdAt: "desc" }
      });
    } else {
      // 사용자 그룹에 속한 VM이 있는 Job 조회
      const userGroupVms = await prisma.vm.findMany({
        where: {
          groupId: { in: groupIds },
          jobId: { not: null },
          deletedAt: null // 삭제되지 않은 VM만
        },
        select: { jobId: true }
      });

      const jobIds = [...new Set(userGroupVms.map(vm => vm.jobId).filter((id): id is string => id !== null))];

      jobs = await prisma.job.findMany({
        where: { jobId: { in: jobIds } },
        include: {
          vms: {
            where: {
              groupId: { in: groupIds },
              deletedAt: null // 삭제되지 않은 VM만
            },
            include: {
              group: { select: { name: true } }
            }
          },
          key: { select: { fingerprint: true, keyVersion: true, publicKey: true } },
          group: { select: { name: true } }
        },
        orderBy: { createdAt: "desc" }
      });
    }

    // 3. Job에 연결되지 않은 단독 VM (Admin은 모든 VM, 일반 사용자는 자신의 그룹 VM만)
    const standaloneVms = await prisma.vm.findMany({
      where: isAdmin
        ? { jobId: null, deletedAt: null }
        : { groupId: { in: groupIds }, jobId: null, deletedAt: null },
      include: {
        group: { select: { name: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    // 4. 그룹 Job에 연결된 Key 정보
    const keyFingerprints = jobs
      .map(j => j.keyFingerprint)
      .filter((fp): fp is string => fp !== null);

    const keys = await prisma.key.findMany({
      where: { fingerprint: { in: keyFingerprints } },
      select: { fingerprint: true, keyVersion: true, createdAt: true }
    });

    // 5. Admin인 경우 모든 그룹 목록 조회 (VM 그룹 변경용)
    const allGroups = isAdmin ? await prisma.group.findMany({ orderBy: { name: 'asc' } }) : [];

    // 6. VM 생성 요청 목록 (내 그룹 또는 전체)
    const rawVmRequests = await prisma.vmRequest.findMany({
      where: isAdmin ? {} : { groupId: { in: groupIds } },
      include: { group: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });

    // 요청자 이메일 매핑
    const requesterIds = [...new Set(rawVmRequests.map(r => r.requestedBy).filter(Boolean))];
    const requesters = await prisma.user.findMany({
      where: { id: { in: requesterIds } },
      select: { id: true, email: true },
    });
    const requesterMap = Object.fromEntries(requesters.map(u => [u.id, u.email]));
    const vmRequests = rawVmRequests.map(r => ({
      ...r,
      requesterEmail: requesterMap[r.requestedBy] || r.requestedBy,
    }));

    // 7. 그룹 할당량 정보
    const groupQuotas = await Promise.all(
      groupIds.map(async (tid) => {
        try { return await getGroupQuotaUsage(tid); }
        catch { return null; }
      })
    ).then(results => results.filter(Boolean));

    // 8. Instance Type 목록
    const instanceTypes = await prisma.deployTemplate.findMany({
      orderBy: { sortOrder: "asc" },
    });

    const rotateModeCfg = await prisma.systemConfig.findUnique({ where: { key: "key_rotate_mode" } });
    const keyRotateAdminOnly = (rotateModeCfg?.value ?? "admin_only") === "admin_only";

    // 9. 오프라인 노드 목록 조회 → 해당 노드 VM 상태를 렌더 시 unknown으로 강제
    const pveNodes = await prisma.pveNode.findMany({ select: { name: true, isOnline: true } });
    const offlineNodeNames = new Set(pveNodes.filter(n => !n.isOnline).map(n => n.name));

    const forceOfflineStatus = (vm: any) =>
      vm.node && offlineNodeNames.has(vm.node) ? { ...vm, status: 'unknown' } : vm;

    const fixedJobs = jobs.map(job => ({
      ...job,
      vms: job.vms.map(forceOfflineStatus),
    }));
    const fixedStandaloneVms = standaloneVms.map(forceOfflineStatus);

    res.render("index", {
      user: req.user!,
      groups: memberships.map(m => m.group),
      jobs: fixedJobs,
      standaloneVms: fixedStandaloneVms,
      keys,
      isAdmin,
      allGroups,
      vmRequests,
      groupQuotas,
      instanceTypes,
      keyRotateAdminOnly,
    });
  } catch (error) {
    console.error("Dashboard Render Error:", error);
    res.status(500).send("대시보드를 불러오는 중 오류가 발생했습니다.");
  }
});

/**
 * [GET] /admin - 관리자 페이지
 */
uiRoutes.get("/admin", requireLogin, requireAdmin, async (req, res) => {
  try {
    res.render("admin", {
      user: req.user!,
      isAdmin: true,
      initialAdminEmail: (process.env.INITIAL_ADMIN_EMAIL || "").trim(),
    });
  } catch (error) {
    console.error("Admin Page Error:", error);
    res.status(500).send("관리자 페이지를 불러오는 중 오류가 발생했습니다.");
  }
});
