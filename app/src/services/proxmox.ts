/**
 * Proxmox VE REST API 클라이언트
 * https://pve.proxmox.com/pve-docs/api-viewer/
 *
 * 멀티노드 클러스터를 지원하며, API Token 기반 인증을 사용합니다.
 */

import https from "https";

// Proxmox 자체서명 인증서 허용
const agent = new https.Agent({ rejectUnauthorized: false });
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export interface PveApiResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface PveNodeStatus {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

export interface PveClusterStatusNode {
  type: string;
  name?: string;
  ip?: string;
  local?: number;
  online?: number;
}

export interface PveClusterConfigNode {
  node: string;
  ring0_addr?: string;
}

export interface PveStorage {
  storage: string;
  type: string;
  content: string;
  avail: number;
  total: number;
  used: number;
  active: number;
  pool?: string; // zfspool 타입: 실제 ZFS 풀 이름 (스토리지 ID와 다를 수 있음)
}

export interface PveZfsPool {
  name: string;
  size: number;   // total bytes
  alloc: number;  // allocated (used) bytes
  free: number;   // free bytes
  health: string;
  dedup?: number;
  frag?: number;
}

export interface PveNetwork {
  iface: string;
  type: string;
  active: number;
  address?: string;
  netmask?: string;
  // Present in some PVE API responses (e.g., for the interface that owns default route).
  gateway?: string;
  bridge_ports?: string;
}

export interface PveStorageContentItem {
  volid: string;
  content: string;
  format?: string;
  size?: number;
}

export interface PveVmInfo {
  vmid: number;
  name?: string;
  status: string;
  node?: string;
  template?: number;
  maxmem?: number;
  maxdisk?: number;
  cpus?: number;
}

export interface PveTaskStatus {
  status: string; // "running" | "stopped"
  exitstatus?: string; // "OK" on success
  type: string;
  upid: string;
}

export class ProxmoxClient {
  private baseUrl: string;
  private tokenId: string;
  private tokenSecret: string;

  constructor(host: string, tokenId: string, tokenSecret: string) {
    // host가 슬래시로 끝나면 제거
    this.baseUrl = host.replace(/\/+$/, "") + "/api2/json";
    this.tokenId = tokenId;
    this.tokenSecret = tokenSecret;
  }

  private get headers() {
    return {
      Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Proxmox API 요청 공통 메서드
   */
  private async request<T = any>(
    method: string,
    path: string,
    body?: any
  ): Promise<PveApiResult<T>> {
    const url = `${this.baseUrl}${path}`;

    try {
      const options: RequestInit = {
        method,
        headers: {
          Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
        },
        // @ts-ignore - Node.js fetch agent 지원
        agent,
      };

      if (method === "POST" || method === "PUT") {
        // Proxmox API는 form-urlencoded를 선호
        const params = new URLSearchParams();
        if (body && typeof body === "object") {
          for (const [key, val] of Object.entries(body)) {
            if (val !== undefined && val !== null) {
              params.append(key, String(val));
            }
          }
        }
        options.body = params.toString();
        (options.headers as any)["Content-Type"] =
          "application/x-www-form-urlencoded";
      }

      const res = await fetch(url, options);
      const raw = await res.text();
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        return {
          ok: false,
          error: json?.errors
            ? JSON.stringify(json.errors)
            : raw || `HTTP ${res.status}: ${res.statusText}`,
        };
      }

      return { ok: true, data: json?.data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  // ─── 연결 테스트 ───

  async testConnection(): Promise<PveApiResult<PveNodeStatus[]>> {
    return this.request<PveNodeStatus[]>("GET", "/nodes");
  }

  // ─── 노드 ───

  async getNodes(): Promise<PveApiResult<PveNodeStatus[]>> {
    return this.request<PveNodeStatus[]>("GET", "/nodes");
  }

  async clusterStatus(): Promise<PveApiResult<PveClusterStatusNode[]>> {
    return this.request<PveClusterStatusNode[]>("GET", "/cluster/status");
  }

  async clusterConfigNodes(): Promise<PveApiResult<PveClusterConfigNode[]>> {
    return this.request<PveClusterConfigNode[]>("GET", "/cluster/config/nodes");
  }

  async getNodeStatus(node: string): Promise<PveApiResult<any>> {
    return this.request("GET", `/nodes/${node}/status`);
  }

  async getNodeNetwork(node: string): Promise<PveApiResult<PveNetwork[]>> {
    return this.request<PveNetwork[]>("GET", `/nodes/${node}/network`);
  }

  // ─── 스토리지 ───

  async getStoragePools(node: string): Promise<PveApiResult<PveStorage[]>> {
    return this.request<PveStorage[]>("GET", `/nodes/${node}/storage`);
  }

  async getZfsPools(node: string): Promise<PveApiResult<PveZfsPool[]>> {
    return this.request<PveZfsPool[]>("GET", `/nodes/${node}/disks/zfs`);
  }

  async getStorageContent(
    node: string,
    storage: string,
    content?: string
  ): Promise<PveApiResult<PveStorageContentItem[]>> {
    const query = content
      ? `?content=${encodeURIComponent(content)}`
      : "";
    return this.request<PveStorageContentItem[]>(
      "GET",
      `/nodes/${node}/storage/${storage}/content${query}`
    );
  }

  // ─── 네트워크 ───

  async getNetworkBridges(node: string): Promise<PveApiResult<PveNetwork[]>> {
    // Some environments return empty data for `?type=bridge` despite bridge
    // interfaces existing, so fetch all and filter locally for robustness.
    const res = await this.request<PveNetwork[]>("GET", `/nodes/${node}/network`);
    if (!res.ok || !res.data) return res;

    const bridges = res.data.filter((n) => {
      const iface = String(n.iface || "").toLowerCase();
      const type = String(n.type || "").toLowerCase();
      return type === "bridge" || iface.startsWith("vmbr");
    });

    return { ok: true, data: bridges };
  }

  // ─── VM 조회 ───

  async getVmList(node: string): Promise<PveApiResult<PveVmInfo[]>> {
    return this.request<PveVmInfo[]>("GET", `/nodes/${node}/qemu`);
  }

  async getVmStatus(
    node: string,
    vmid: number
  ): Promise<PveApiResult<any>> {
    return this.request("GET", `/nodes/${node}/qemu/${vmid}/status/current`);
  }

  async getVmConfig(
    node: string,
    vmid: number
  ): Promise<PveApiResult<any>> {
    return this.request("GET", `/nodes/${node}/qemu/${vmid}/config`);
  }

  /**
   * 템플릿 VM 목록 조회
   */
  async getTemplateVms(node: string): Promise<PveApiResult<PveVmInfo[]>> {
    const res = await this.getVmList(node);
    if (!res.ok || !res.data) return res;
    return {
      ok: true,
      data: res.data.filter((vm) => vm.template === 1),
    };
  }

  // ─── 클러스터 ───

  async getClusterResources(
    type?: string
  ): Promise<PveApiResult<any[]>> {
    const query = type ? `?type=${type}` : "";
    return this.request("GET", `/cluster/resources${query}`);
  }

  /**
   * 클러스터 전체에서 VMID 존재 여부 확인
   */
  async checkVmidExists(vmid: number): Promise<boolean> {
    const res = await this.getClusterResources("vm");
    if (!res.ok || !res.data) return false;
    return res.data.some((r: any) => r.vmid === vmid);
  }

  /**
   * 클러스터에서 사용 가능한 다음 VMID 찾기
   */
  async findNextAvailableVmid(startFrom: number = 100): Promise<number> {
    // Prefer Proxmox cluster allocator to avoid collisions across nodes.
    const nextIdRes = await this.request<any>(
      "GET",
      `/cluster/nextid?vmid=${encodeURIComponent(String(startFrom))}`
    );
    if (nextIdRes.ok && nextIdRes.data !== undefined && nextIdRes.data !== null) {
      const parsed = parseInt(String(nextIdRes.data), 10);
      if (!Number.isNaN(parsed)) return parsed;
    }

    // Fallback: scan visible cluster resources.
    const res = await this.getClusterResources("vm");
    if (!res.ok || !res.data) return startFrom;
    const usedIds = new Set(
      res.data
        .map((r: any) => parseInt(String(r.vmid), 10))
        .filter((n: number) => !Number.isNaN(n))
    );
    let vmid = startFrom;
    while (usedIds.has(vmid)) vmid++;
    return vmid;
  }

  // ─── VM 생성 ───

  /**
   * Cloud Image 기반 VM 생성
   */
  async createVm(
    node: string,
    vmid: number,
    params: {
      name?: string;
      memory: number;
      cores: number;
      cpu?: string;
      agent?: number;
      ostype?: string;
      scsihw?: string;
      boot?: string;
      net0?: string;
      serial0?: string;
      vga?: string;
      [key: string]: any;
    }
  ): Promise<PveApiResult<string>> {
    return this.request<string>("POST", `/nodes/${node}/qemu`, {
      vmid,
      ...params,
    });
  }

  /**
   * 템플릿 VM 클론
   */
  async cloneVm(
    node: string,
    sourceVmid: number,
    newVmid: number,
    params: {
      name?: string;
      full?: number; // 1 = full clone
      storage?: string;
      target?: string;
    }
  ): Promise<PveApiResult<string>> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/qemu/${sourceVmid}/clone`,
      { newid: newVmid, ...params }
    );
  }

  /**
   * VM 설정 변경
   */
  async configureVm(
    node: string,
    vmid: number,
    params: Record<string, any>
  ): Promise<PveApiResult<any>> {
    return this.request("PUT", `/nodes/${node}/qemu/${vmid}/config`, params);
  }

  /**
   * 디스크 리사이즈
   */
  async resizeDisk(
    node: string,
    vmid: number,
    disk: string,
    size: string
  ): Promise<PveApiResult<any>> {
    return this.request("PUT", `/nodes/${node}/qemu/${vmid}/resize`, {
      disk,
      size,
    });
  }

  // ─── VM 제어 ───

  async startVm(
    node: string,
    vmid: number
  ): Promise<PveApiResult<string>> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/qemu/${vmid}/status/start`
    );
  }

  async stopVm(
    node: string,
    vmid: number
  ): Promise<PveApiResult<string>> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/qemu/${vmid}/status/stop`
    );
  }

  async shutdownVm(
    node: string,
    vmid: number
  ): Promise<PveApiResult<string>> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/qemu/${vmid}/status/shutdown`
    );
  }

  async rebootVm(
    node: string,
    vmid: number
  ): Promise<PveApiResult<string>> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/qemu/${vmid}/status/reboot`
    );
  }

  async deleteVm(
    node: string,
    vmid: number,
    purge: boolean = true
  ): Promise<PveApiResult<string>> {
    const query = purge ? "?purge=1&destroy-unreferenced-disks=1" : "";
    return this.request<string>(
      "DELETE",
      `/nodes/${node}/qemu/${vmid}${query}`
    );
  }

  // ─── QEMU Guest Agent ───

  /**
   * VM 내부에서 명령 실행 (QEMU guest agent 필요)
   * POST /nodes/{node}/qemu/{vmid}/agent/exec
   */
  async agentExec(
    node: string,
    vmid: number,
    command: string[]
  ): Promise<PveApiResult<{ pid: number }>> {
    const url = `${this.baseUrl}/nodes/${node}/qemu/${vmid}/agent/exec`;
    try {
      const params = new URLSearchParams();
      command.forEach(arg => params.append("command", arg));
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        // @ts-ignore
        agent,
      });
      const json = await res.json();
      if (!res.ok) return { ok: false, error: JSON.stringify(json.errors || json) };
      return { ok: true, data: json.data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * QEMU Guest Agent 응답 확인 (ping)
   * POST /nodes/{node}/qemu/{vmid}/agent/ping
   * Agent 미설치/VM 부팅 중이면 에러 반환
   */
  async agentPing(node: string, vmid: number): Promise<PveApiResult<void>> {
    return this.request("POST", `/nodes/${node}/qemu/${vmid}/agent/ping`);
  }

  /**
   * QEMU Guest Agent 네트워크 인터페이스 조회
   * GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces
   */
  async agentNetworkGetInterfaces(
    node: string,
    vmid: number
  ): Promise<PveApiResult<Array<{ name?: string; ["ip-addresses"]?: Array<{ ["ip-address"]?: string; ["ip-address-type"]?: string }> }>>> {
    return this.request(
      "GET",
      `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`
    );
  }

  /**
   * agent/exec 결과 폴링
   * GET /nodes/{node}/qemu/{vmid}/agent/exec-status?pid={pid}
   */
  async agentExecStatus(
    node: string,
    vmid: number,
    pid: number
  ): Promise<PveApiResult<{ exited: boolean; exitcode?: number; "out-data"?: string; "err-data"?: string }>> {
    return this.request("GET", `/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
  }

  // ─── 태스크 모니터링 ───

  async getTaskStatus(
    node: string,
    upid: string
  ): Promise<PveApiResult<PveTaskStatus>> {
    return this.request<PveTaskStatus>(
      "GET",
      `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`
    );
  }

  /**
   * 태스크 완료까지 대기 (폴링)
   */
  async waitForTask(
    node: string,
    upid: string,
    timeoutMs: number = 300000,
    intervalMs: number = 3000
  ): Promise<PveApiResult<PveTaskStatus>> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = await this.getTaskStatus(node, upid);
      if (!res.ok) return res;

      if (res.data?.status === "stopped") {
        if (res.data.exitstatus === "OK") {
          return { ok: true, data: res.data };
        }
        return {
          ok: false,
          error: `Task failed: ${res.data.exitstatus}`,
          data: res.data,
        };
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return { ok: false, error: "Task timeout" };
  }

  // ─── 스토리지 업로드 (Cloud-init snippet) ───

  /**
   * Snippets 스토리지에 파일 업로드
   * Proxmox는 multipart/form-data로 파일 업로드를 받음
   */
  async uploadSnippet(
    node: string,
    storage: string,
    filename: string,
    content: string
  ): Promise<PveApiResult<any>> {
    const url = `${this.baseUrl}/nodes/${node}/storage/${storage}/upload`;
    const boundary = "----PveUpload" + Date.now();

    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="content"',
      "",
      "snippets",
      `--${boundary}`,
      `Content-Disposition: form-data; name="filename"; filename="${filename}"`,
      "Content-Type: application/octet-stream",
      "",
      content,
      `--${boundary}--`,
    ].join("\r\n");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        // @ts-ignore
        agent,
      });

      const json = await res.json();
      if (!res.ok) {
        return { ok: false, error: JSON.stringify(json) };
      }
      return { ok: true, data: json.data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  // ─── Cloud Image 다운로드 ───

  /**
   * 노드에 Cloud Image 다운로드 (Proxmox 7.2+ download-url API)
   */
  async downloadImageToStorage(
    node: string,
    storage: string,
    url: string,
    filename: string,
    content: string = "iso"
  ): Promise<PveApiResult<string>> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/storage/${storage}/download-url`,
      {
        url,
        filename,
        content,
      }
    );
  }
}
