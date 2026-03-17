import { Router } from "express";
import { prisma } from "../../services/prisma";
import { requireLogin } from "../middlewares/requireLogin";

/** CSV 필드 이스케이프 */
function csvEscape(val: string | number | null | undefined): string {
  const str = val == null ? '' : String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export const vmsApi = Router();

/**
 * POST /api/vms/register
 * Legacy endpoint (deprecated).
 */
vmsApi.post("/register", async (_req, res) => {
  return res.status(410).json({
    error: "LEGACY_ENDPOINT_DEPRECATED",
    message: "/api/vms/register is deprecated. Use admin deploy flow via /api/admin/vm-requests/* and /api/deploy/*."
  });
});

/**
 * POST /api/vms/register-batch
 * Legacy endpoint (deprecated).
 */
vmsApi.post("/register-batch", async (_req, res) => {
  return res.status(410).json({
    error: "LEGACY_ENDPOINT_DEPRECATED",
    message: "/api/vms/register-batch is deprecated. Use admin deploy flow via /api/admin/vm-requests/* and /api/deploy/*."
  });
});

/**
 * GET /api/vms/export
 * Export VMs accessible to the logged-in user as CSV
 * Admin: exports all VMs
 * Regular user: exports only VMs from their groups
 */
vmsApi.get("/export", requireLogin, async (req, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = (req.user as any).isAdmin || false;

    let vms;

    if (isAdmin) {
      // Admin: export all non-deleted VMs
      vms = await prisma.vm.findMany({
        where: { deletedAt: null },
        include: {
          group: true,
          job: {
            include: { key: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      });
    } else {
      // Regular user: export only VMs from their groups
      const memberships = await prisma.groupMembership.findMany({
        where: { userId },
        select: { groupId: true }
      });
      const groupIds = memberships.map(m => m.groupId);

      vms = await prisma.vm.findMany({
        where: {
          deletedAt: null,
          groupId: { in: groupIds }
        },
        include: {
          group: true,
          job: {
            include: { key: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      });
    }

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
    res.setHeader('Content-Disposition', `attachment; filename="my_vms_${timestamp}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8 support
  } catch (e: any) {
    console.error("[VMs CSV export error]", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
