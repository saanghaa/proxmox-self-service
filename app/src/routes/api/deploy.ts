/**
 * VM 배포 시스템 API 라우트
 * Proxmox VE REST API를 통한 VM 자동 생성/관리
 * maintainer_name: Lee Sangha
 * maintainer_email: saanghaa@gmail.com
 * roles: DevOps Engineer, Site Reliability Engineer, Cloud Solutions Architect
 */

import { Router } from "express";
import { prisma } from "../../services/prisma";
import { ProxmoxClient } from "../../services/proxmox";
import { encryptText, decryptText } from "../../services/crypto";
import { verifyTotp } from "../../services/totp";
import { writeAudit } from "../../services/audit";
import { getClientIp } from "../../utils/requestIp";
import { requireLogin } from "../middlewares/requireLogin";
import { requireAdmin } from "../middlewares/requireAdmin";

export const deployApi = Router();

// 모든 배포 API는 관리자 전용
deployApi.use(requireLogin, requireAdmin);

function normalizePveHostInput(raw: string): string {
  let input = String(raw || "").trim();
  if (!input) return input;

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  try {
    const url = new URL(input);
    if (!url.port) url.port = "8006";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return input.replace(/\/+$/, "");
  }
}

function inferPveApiPort(host: string): string {
  try {
    const url = new URL(host);
    return url.port ? `:${url.port}` : ":8006";
  } catch {
    const match = String(host || "").match(/:(\d+)$/);
    return match ? `:${match[1]}` : ":8006";
  }
}

type DiscoveredPveNode = {
  name: string;
  host: string;
};

async function discoverPveClusterNodes(
  host: string,
  tokenId: string,
  tokenSecret: string
): Promise<{
  nodes: DiscoveredPveNode[];
  localNodeName: string | null;
}> {
  const client = new ProxmoxClient(host, tokenId, tokenSecret);
  const nodesRes = await client.getNodes();

  if (!nodesRes.ok || !nodesRes.data?.length) {
    throw new Error(nodesRes.error || "NODE_DISCOVERY_FAILED");
  }

  const nodeNames = nodesRes.data
    .map((node) => String(node.node || "").trim())
    .filter(Boolean);

  if (nodeNames.length === 0) {
    throw new Error("NODE_DISCOVERY_EMPTY");
  }

  const port = inferPveApiPort(host);
  const ipMap = new Map<string, string>();
  const mgmtIpMap = new Map<string, string>();
  let localNodeName: string | null = null;

  const clusterStatus = await client.clusterStatus();
  if (clusterStatus.ok && clusterStatus.data) {
    for (const item of clusterStatus.data) {
      if (item.type !== "node" || !item.name) continue;
      if (item.local === 1) localNodeName = item.name;
      if (item.ip) ipMap.set(item.name, `https://${item.ip}${port}`);
    }
  }

  const clusterConfig = await client.clusterConfigNodes();
  if (clusterConfig.ok && clusterConfig.data) {
    for (const item of clusterConfig.data) {
      if (item.node && item.ring0_addr) {
        ipMap.set(item.node, `https://${item.ring0_addr}${port}`);
      }
    }
  }

  await Promise.all(
    nodeNames
      .filter((name) => name !== localNodeName)
      .map(async (name) => {
        const netRes = await client.getNodeNetwork(name);
        if (!netRes.ok || !netRes.data?.length) return;

        // 관리망은 기본 게이트웨이가 설정된 인터페이스를 우선 사용한다.
        const managementIface = netRes.data.find((iface) => iface.gateway && iface.address);
        const managementAddress = managementIface?.address?.split("/")[0];
        if (managementAddress) {
          mgmtIpMap.set(name, `https://${managementAddress}${port}`);
        }
      })
  );

  if (localNodeName) {
    ipMap.set(localNodeName, host);
  } else if (nodeNames.length === 1) {
    localNodeName = nodeNames[0];
    ipMap.set(localNodeName, host);
  }

  const nodes = nodeNames.map((name) => ({
    name,
    // proxmox-self-service와 동일하게:
    // 로컬 노드는 입력한 host를 유지하고,
    // 비로컬 노드는 gateway가 있는 관리 인터페이스 주소만 사용한다.
    host: name === localNodeName ? host : (mgmtIpMap.get(name) || ""),
  }));

  return { nodes, localNodeName };
}

// ─── 헬퍼: PveNode에서 ProxmoxClient 생성 ───

async function getClient(nodeId: string): Promise<ProxmoxClient | null> {
  const node = await prisma.pveNode.findUnique({ where: { id: nodeId } });
  if (!node) return null;
  return new ProxmoxClient(node.host, node.tokenId, decryptText(node.tokenSecret));
}

// ═══════════════════════════════════════════
//  PVE 노드 관리
// ═══════════════════════════════════════════

/**
 * PVE 노드 목록 조회 (실시간 연결 테스트 후 isOnline/lastChecked 갱신)
 */
deployApi.get("/nodes", async (req, res) => {
  try {
    const nodes = await prisma.pveNode.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        host: true,
        tokenId: true,
        tokenSecret: true,
        isOnline: true,
        lastChecked: true,
        createdAt: true,
      },
    });

    const now = new Date();

    // 모든 노드에 대해 병렬로 연결 테스트 수행
    const results = await Promise.allSettled(
      nodes.map(async (node) => {
        try {
          const client = new ProxmoxClient(node.host, node.tokenId, decryptText(node.tokenSecret));
          const test = await client.testConnection();
          await prisma.pveNode.update({
            where: { id: node.id },
            data: { isOnline: test.ok, lastChecked: now },
          });
          return { ...node, isOnline: test.ok, lastChecked: now };
        } catch {
          await prisma.pveNode.update({
            where: { id: node.id },
            data: { isOnline: false, lastChecked: now },
          });
          return { ...node, isOnline: false, lastChecked: now };
        }
      })
    );

    const updatedNodes = results.map((result, i) => {
      const { tokenSecret, ...rest } = result.status === 'fulfilled' ? result.value : { ...nodes[i], isOnline: false, lastChecked: now };
      return rest;
    });

    res.json({ ok: true, nodes: updatedNodes });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드 등록
 */
deployApi.post("/nodes", async (req, res) => {
  try {
    const { name, host, tokenId, tokenSecret } = req.body;

    if (!host || !tokenId || !tokenSecret) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const normalizedHost = normalizePveHostInput(host);
    const discovered = await discoverPveClusterNodes(normalizedHost, tokenId, tokenSecret);
    const primaryName = String(name || "").trim() || discovered.localNodeName || discovered.nodes[0]?.name;

    if (!primaryName) {
      return res.status(502).json({ error: "NODE_NAME_DISCOVERY_FAILED" });
    }

    const encryptedSecret = encryptText(tokenSecret);
    const discoveredByName = new Map(discovered.nodes.map((node) => [node.name, node]));
    const primaryNodeInfo = discoveredByName.get(primaryName);
    const primaryHost = primaryNodeInfo?.host || normalizedHost;

    const client = new ProxmoxClient(primaryHost, tokenId, tokenSecret);
    const test = await client.testConnection();

    const node = await prisma.pveNode.create({
      data: {
        name: primaryName,
        host: primaryHost,
        tokenId,
        tokenSecret: encryptedSecret,
        isOnline: test.ok,
        lastChecked: new Date(),
      },
    });

    const existingNames = new Set([primaryName]);
    const existingHosts = new Set([primaryHost]);
    let clusterAdded = 0;
    let clusterSkipped = 0;
    const clusterErrors: string[] = [];

    const registered = await prisma.pveNode.findMany({ select: { name: true, host: true } });
    registered.forEach((item) => {
      existingNames.add(item.name);
      existingHosts.add(item.host);
    });

    for (const extraNode of discovered.nodes) {
      if (!extraNode.name || extraNode.name === primaryName) continue;
      if (existingNames.has(extraNode.name) || (extraNode.host && existingHosts.has(extraNode.host))) {
        clusterSkipped++;
        continue;
      }
      if (!extraNode.host) {
        clusterErrors.push(`${extraNode.name}: HOST_NOT_DISCOVERED`);
        continue;
      }
      try {
        const extraClient = new ProxmoxClient(extraNode.host, tokenId, tokenSecret);
        const extraTest = await extraClient.testConnection();
        await prisma.pveNode.create({
          data: {
            name: extraNode.name,
            host: extraNode.host,
            tokenId,
            tokenSecret: encryptedSecret,
            isOnline: extraTest.ok,
            lastChecked: new Date(),
          },
        });
        existingNames.add(extraNode.name);
        existingHosts.add(extraNode.host);
        clusterAdded++;
      } catch (extraError: any) {
        if (extraError?.code === "P2002") {
          clusterSkipped++;
          existingNames.add(extraNode.name);
        } else {
          clusterErrors.push(`${extraNode.name}: ${extraError?.message || "CREATE_FAILED"}`);
        }
      }
    }

    res.json({
      ok: true,
      node: { id: node.id, name: node.name, host: node.host, isOnline: node.isOnline },
      connectionTest: test.ok ? "SUCCESS" : test.error,
      clusterSync: {
        added: clusterAdded,
        skipped: clusterSkipped,
        errors: clusterErrors,
        totalDiscovered: discovered.nodes.length,
      },
    });
  } catch (e: any) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "NODE_NAME_EXISTS" });
    }
    res.status(500).json({ error: e.message });
  }
});

deployApi.post("/nodes/fetch-name", async (req, res) => {
  try {
    const { host, tokenId, tokenSecret } = req.body || {};
    if (!host || !tokenId || !tokenSecret) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const normalizedHost = normalizePveHostInput(host);
    const discovered = await discoverPveClusterNodes(normalizedHost, tokenId, tokenSecret);
    const primaryName = discovered.localNodeName || discovered.nodes[0]?.name || null;

    res.json({
      ok: true,
      name: primaryName,
      localNodeName: discovered.localNodeName,
      nodes: discovered.nodes,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드 수정
 * tokenSecret 미입력 시 기존 시크릿 유지
 */
deployApi.put("/nodes/:id", async (req, res) => {
  try {
    const { name, host, tokenId, tokenSecret } = req.body;
    const id = req.params.id;

    if (!name || !host || !tokenId) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const existing = await prisma.pveNode.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    const normalizedHost = normalizePveHostInput(host);
    const effectiveSecret = tokenSecret
      ? String(tokenSecret)
      : decryptText(existing.tokenSecret);

    // 수정된 연결 정보로 즉시 테스트
    const client = new ProxmoxClient(normalizedHost, tokenId, effectiveSecret);
    const test = await client.testConnection();

    const updated = await prisma.pveNode.update({
      where: { id },
      data: {
        name,
        host: normalizedHost,
        tokenId,
        tokenSecret: tokenSecret ? encryptText(effectiveSecret) : existing.tokenSecret,
        isOnline: test.ok,
        lastChecked: new Date(),
      },
      select: {
        id: true,
        name: true,
        host: true,
        tokenId: true,
        isOnline: true,
        lastChecked: true,
      },
    });

    res.json({
      ok: true,
      node: updated,
      connectionTest: test.ok ? "SUCCESS" : test.error,
    });
  } catch (e: any) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "NODE_NAME_EXISTS" });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드 삭제
 */
deployApi.delete("/nodes/:id", async (req, res) => {
  try {
    await prisma.pveNode.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드 연결 테스트
 */
deployApi.post("/nodes/:id/test", async (req, res) => {
  try {
    const client = await getClient(req.params.id);
    if (!client) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    const result = await client.testConnection();

    await prisma.pveNode.update({
      where: { id: req.params.id },
      data: { isOnline: result.ok, lastChecked: new Date() },
    });

    if (result.ok && result.data) {
      res.json({
        ok: true,
        nodes: result.data.map((n) => ({
          node: n.node,
          status: n.status,
          cpu: n.cpu,
          maxcpu: n.maxcpu,
          memUsed: n.mem,
          memTotal: n.maxmem,
          uptime: n.uptime,
        })),
      });
    } else {
      res.json({ ok: false, error: result.error });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드 토큰 정보 조회 (OTP 재인증 필수)
 */
deployApi.post("/nodes/:id/reveal-token", async (req, res) => {
  try {
    const { otp } = req.body || {};
    if (!otp || String(otp).trim().length < 6) {
      return res.status(400).json({ error: "MISSING_OTP" });
    }

    if (!req.user?.totpEnabled || !req.user?.totpSecret) {
      return res.status(403).json({ error: "OTP_NOT_ENABLED" });
    }

    const valid = verifyTotp(req.user as any, String(otp).trim());
    if (!valid) {
      await writeAudit({
        userId: req.user?.id,
        action: "OTP_VERIFY",
        result: "FAIL",
        reason: "INVALID_OTP_FOR_PROXMOX_TOKEN_VIEW",
        requestIp: getClientIp(req),
        userAgent: req.headers["user-agent"],
      });
      return res.status(401).json({ error: "INVALID_OTP" });
    }

    const node = await prisma.pveNode.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        host: true,
        tokenId: true,
        tokenSecret: true,
      },
    });
    if (!node) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    await writeAudit({
      userId: req.user?.id,
      action: "PROXMOX_TOKEN_VIEW",
      result: "SUCCESS",
      reason: `Reveal Proxmox token for ${node.name}`,
      requestIp: getClientIp(req),
      userAgent: req.headers["user-agent"],
    });

    res.json({
      ok: true,
      id: node.id,
      name: node.name,
      host: node.host,
      tokenId: node.tokenId,
      tokenSecret: decryptText(node.tokenSecret),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드의 스토리지 풀 목록
 */
deployApi.get("/nodes/:id/storage", async (req, res) => {
  try {
    const pveNode = await prisma.pveNode.findUnique({ where: { id: req.params.id } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    const client = await getClient(req.params.id);
    if (!client) return res.status(500).json({ error: "CLIENT_ERROR" });

    // 클러스터 내 모든 노드 조회해서 대상 노드명으로 요청
    const targetNode = req.query.node as string || pveNode.name;
    const result = await client.getStoragePools(targetNode);

    if (result.ok && result.data) {
      const pools = result.data
        .filter((s) => s.active === 1)
        .map((s) => ({
          name: s.storage,
          type: s.type,
          content: s.content,
          availGb: Math.round(s.avail / 1073741824),
          totalGb: Math.round(s.total / 1073741824),
          usedGb: Math.round(s.used / 1073741824),
          usagePercent: s.total > 0 ? Math.round((s.used / s.total) * 100) : 0,
        }));
      res.json({ ok: true, pools });
    } else {
      res.json({ ok: false, error: result.error });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드의 Cloud Image 파일 목록 (import 콘텐츠에서 img/raw/qcow2)
 */
deployApi.get("/nodes/:id/cloud-images", async (req, res) => {
  try {
    const pveNode = await prisma.pveNode.findUnique({ where: { id: req.params.id } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    const client = await getClient(req.params.id);
    if (!client) return res.status(500).json({ error: "CLIENT_ERROR" });

    const targetNode = (req.query.node as string) || pveNode.name;
    const storagesRes = await client.getStoragePools(targetNode);
    if (!storagesRes.ok || !Array.isArray(storagesRes.data)) {
      return res.json({ ok: false, error: storagesRes.error || "STORAGE_LIST_FAILED" });
    }

    // Some PVE setups have an `import/` directory but the storage's `content`
    // list doesn't include "import". Query all active storages and filter by
    // volid/content so UI can still list import images.
    const candidateStorages = storagesRes.data.filter((s) => s.active === 1);

    const images: Array<{
      volid: string;
      storage: string;
      file: string;
      size: number | null;
      format: string | null;
    }> = [];

    for (const s of candidateStorages) {
      // Prefer `content=import` when supported, but fall back to an unfiltered
      // content listing for older/quirky environments.
      let contentRes = await client.getStorageContent(targetNode, s.storage, "import");
      if (!contentRes.ok || !Array.isArray(contentRes.data) || contentRes.data.length === 0) {
        contentRes = await client.getStorageContent(targetNode, s.storage);
      }
      if (!contentRes.ok || !Array.isArray(contentRes.data)) continue;

      for (const item of contentRes.data) {
        const volid = String(item.volid || "");
        const content = String(item.content || "");
        const isImport = content === "import" || volid.includes(":import/");
        if (!isImport) continue;

        const file = volid.includes(":import/") ? (volid.split(":import/")[1] || "") : volid;
        const lower = file.toLowerCase();
        if (!lower.endsWith(".img") && !lower.endsWith(".raw") && !lower.endsWith(".qcow2")) {
          continue;
        }

        images.push({
          volid,
          storage: s.storage,
          file,
          size: typeof item.size === "number" ? item.size : null,
          format: item.format || null,
        });
      }
    }

    images.sort((a, b) => a.file.localeCompare(b.file));
    res.json({ ok: true, images });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드의 네트워크 브릿지 목록
 */
deployApi.get("/nodes/:id/bridges", async (req, res) => {
  try {
    const pveNode = await prisma.pveNode.findUnique({ where: { id: req.params.id } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    const client = await getClient(req.params.id);
    if (!client) return res.status(500).json({ error: "CLIENT_ERROR" });

    const targetNode = req.query.node as string || pveNode.name;
    const result = await client.getNetworkBridges(targetNode);

    if (result.ok && result.data) {
      const bridges = result.data.map((b) => ({
        name: b.iface,
        active: b.active === 1,
        address: b.address || null,
        netmask: b.netmask || null,
        gateway: (b as any).gateway || null,
        ports: b.bridge_ports || null,
      }));
      res.json({ ok: true, bridges });
    } else {
      res.json({ ok: false, error: result.error });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PVE 노드의 템플릿 VM 목록
 */
deployApi.get("/nodes/:id/templates", async (req, res) => {
  try {
    const pveNode = await prisma.pveNode.findUnique({ where: { id: req.params.id } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    const client = await getClient(req.params.id);
    if (!client) return res.status(500).json({ error: "CLIENT_ERROR" });

    const targetNode = req.query.node as string || pveNode.name;
    const result = await client.getTemplateVms(targetNode);

    if (result.ok && result.data) {
      const templates = result.data.map((vm) => ({
        vmid: vm.vmid,
        name: vm.name || `VM ${vm.vmid}`,
        cpus: vm.cpus,
        maxmem: vm.maxmem ? Math.round(vm.maxmem / 1048576) : 0,
      }));
      res.json({ ok: true, templates });
    } else {
      res.json({ ok: false, error: result.error });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 다음 사용 가능한 VMID 조회
 */
deployApi.get("/nodes/:id/next-vmid", async (req, res) => {
  try {
    const client = await getClient(req.params.id);
    if (!client) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    const startFrom = parseInt(req.query.start as string) || 100;
    const vmid = await client.findNextAvailableVmid(startFrom);
    res.json({ ok: true, vmid });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
//  배포 템플릿(프리셋) 관리
// ═══════════════════════════════════════════

/**
 * 배포 템플릿 목록
 */
deployApi.get("/templates", async (req, res) => {
  try {
    const templates = await prisma.deployTemplate.findMany({
      orderBy: { sortOrder: "asc" },
    });
    res.json({ ok: true, templates });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 배포 템플릿 추가
 */
deployApi.post("/templates", async (req, res) => {
  try {
    const { name, displayName, cpuCores, memoryMb, diskSizeGb, extraDiskGb, extraDiskCount, fsType, description, sortOrder } = req.body;

    if (!name || !displayName || !cpuCores || !memoryMb || !diskSizeGb) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const template = await prisma.deployTemplate.create({
      data: {
        name: name.toUpperCase(),
        displayName,
        cpuCores: parseInt(cpuCores),
        memoryMb: parseInt(memoryMb),
        diskSizeGb: parseInt(diskSizeGb),
        extraDiskGb: parseInt(extraDiskGb) || 0,
        extraDiskCount: parseInt(extraDiskCount) || 0,
        fsType: fsType || "xfs",
        description,
        sortOrder: parseInt(sortOrder) || 0,
      },
    });

    res.json({ ok: true, template });
  } catch (e: any) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "TEMPLATE_NAME_EXISTS" });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * 배포 템플릿 수정
 */
deployApi.patch("/templates/:id", async (req, res) => {
  try {
    const data: any = {};
    const fields = ["displayName", "cpuCores", "memoryMb", "diskSizeGb", "extraDiskGb", "extraDiskCount", "fsType", "description", "sortOrder"];
    const intFields = ["cpuCores", "memoryMb", "diskSizeGb", "extraDiskGb", "extraDiskCount", "sortOrder"];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        data[f] = intFields.includes(f) ? parseInt(req.body[f]) : req.body[f];
      }
    }

    const template = await prisma.deployTemplate.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ ok: true, template });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 배포 템플릿 삭제
 */
deployApi.delete("/templates/:id", async (req, res) => {
  try {
    await prisma.deployTemplate.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
//  배포 작업 관리
// ═══════════════════════════════════════════

/**
 * 배포 작업 목록
 */
deployApi.get("/tasks", async (req, res) => {
  try {
    const tasks = await prisma.deployTask.findMany({
      orderBy: { createdAt: "desc" },
      include: { group: { select: { name: true } } },
      take: 50,
    });
    res.json({ ok: true, tasks });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 배포 작업 상태 조회
 */
deployApi.get("/tasks/:id", async (req, res) => {
  try {
    const task = await prisma.deployTask.findUnique({
      where: { id: req.params.id },
      include: { group: { select: { name: true } } },
    });
    if (!task) return res.status(404).json({ error: "TASK_NOT_FOUND" });
    res.json({ ok: true, task });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * IP 충돌 사전 검사
 */
deployApi.post("/check-ips", async (req, res) => {
  try {
    const { nodeId, startIp, count } = req.body;
    const client = await getClient(nodeId);
    if (!client) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    // 클러스터 리소스에서 모든 VM의 IP 수집
    const resources = await client.getClusterResources("vm");
    const usedIps = new Set<string>();

    if (resources.ok && resources.data) {
      // IP는 config에서 추출해야 하므로 여기서는 기본 검사만 수행
      // 실제 배포 시 개별 VM config를 조회하여 정밀 검사
    }

    // DB에 등록된 VM의 IP도 검사
    const dbVms = await prisma.vm.findMany({
      where: { deletedAt: null, ip: { not: null } },
      select: { ip: true },
    });
    dbVms.forEach((vm) => {
      if (vm.ip) usedIps.add(vm.ip);
    });

    // 요청된 IP 범위와 충돌 확인
    const conflicts: string[] = [];
    const parts = startIp.split(".").map(Number);
    for (let i = 0; i < count; i++) {
      const ip = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3] + i}`;
      if (usedIps.has(ip)) conflicts.push(ip);
    }

    res.json({ ok: true, conflicts, usedIps: usedIps.size });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 배포 실행 (DeployTask 생성 → 백그라운드 실행)
 */
deployApi.post("/execute", async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const {
      groupId, nodeId, templateName, vmSource, sourceTemplateVmid,
      cloudImageVolid,
      vmCount, startVmid, hostnamePrefix, startNumber,
      startIp, gatewayIp, dnsPrimary, dnsSecondary, storagePool, networkBridge,
      sshPort, vmUser,
      cpuCores, memoryMb, diskSizeGb,
      extraDiskGb, extraDiskCount, fsType,
    } = req.body;

    // 필수 필드 검증
    if (!groupId || !nodeId || !vmCount || !startVmid || !hostnamePrefix || !startIp || !gatewayIp || !storagePool || !networkBridge) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    // PVE 노드 확인
    const pveNode = await prisma.pveNode.findUnique({ where: { id: nodeId } });
    if (!pveNode) return res.status(404).json({ error: "NODE_NOT_FOUND" });

    // 그룹 확인
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) return res.status(404).json({ error: "GROUP_NOT_FOUND" });

    // DeployTask 생성
    const task = await prisma.deployTask.create({
      data: {
        groupId,
        node: pveNode.name,
        templateName: templateName || "CUSTOM",
        vmSource: vmSource || "cloud-image",
        sourceTemplateVmid: sourceTemplateVmid ? parseInt(sourceTemplateVmid) : null,
        cloudImageVolid: cloudImageVolid || null,
        vmCount: parseInt(vmCount),
        startVmid: parseInt(startVmid),
        hostnamePrefix,
        startNumber: parseInt(startNumber) || 1,
        startIp,
        gatewayIp,
        dnsPrimary: dnsPrimary || null,
        dnsSecondary: dnsSecondary || null,
        storagePool,
        networkBridge,
        sshPort: parseInt(sshPort) || 2211,
        vmUser: vmUser || "nexususer",
        cpuCores: parseInt(cpuCores) || 4,
        memoryMb: parseInt(memoryMb) || 8192,
        diskSizeGb: parseInt(diskSizeGb) || 100,
        extraDiskGb: parseInt(extraDiskGb) || 0,
        extraDiskCount: parseInt(extraDiskCount) || 0,
        fsType: fsType || "xfs",
        createdBy: userId,
      },
    });

    // 백그라운드 실행 (동적 import로 순환참조 방지)
    const { executeDeploy } = await import("../../services/deployEngine");
    executeDeploy(task.id, nodeId).catch((err) => {
      console.error(`[Deploy] Background execution failed for task ${task.id}:`, err);
    });

    res.json({ ok: true, taskId: task.id, jobId: task.jobId });
  } catch (e: any) {
    console.error("[Deploy] Execute error:", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 배포 작업 취소
 */
deployApi.post("/tasks/:id/cancel", async (req, res) => {
  try {
    const task = await prisma.deployTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "TASK_NOT_FOUND" });

    if (task.status !== "RUNNING" && task.status !== "PENDING") {
      return res.status(400).json({ error: "TASK_NOT_CANCELLABLE" });
    }

    await prisma.deployTask.update({
      where: { id: req.params.id },
      data: { status: "CANCELLED", currentStep: "사용자에 의해 취소됨" },
    });

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
