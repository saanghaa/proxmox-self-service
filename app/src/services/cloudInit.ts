/**
 * Cloud-init YAML 생성기
 * create_vms.sh의 generate_cloud_init_yaml() 로직을 TypeScript로 변환
 */

export interface CloudInitParams {
  hostname: string;
  vmUser: string;
  vmPassword: string;
  publicKey: string;
  sshPort: number;
  ip: string;
  gateway: string;
  // 추가 디스크
  extraDiskCount: number;
  extraDiskGb: number;
  fsType: string; // "xfs" | "ext4"
}

/**
 * Cloud-init user-data YAML 생성
 */
export function generateCloudInitYaml(params: CloudInitParams): string {
  const {
    hostname,
    vmUser,
    vmPassword,
    publicKey,
    sshPort,
    extraDiskCount,
    extraDiskGb,
    fsType,
  } = params;

  const lines: string[] = [
    "#cloud-config",
    `user: ${vmUser}`,
    `password: '${vmPassword.replace(/'/g, "''")}'`,
    "chpasswd:",
    "  expire: false",
    `hostname: ${hostname}`,
    `fqdn: ${hostname}`,
    "manage_etc_hosts: true",
    "disable_root: true",
    "",
    "users:",
    `  - name: ${vmUser}`,
    "    groups: sudo",
    "    shell: /bin/bash",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    lock_passwd: false",
    "    ssh_authorized_keys:",
    `      - ${publicKey.trim()}`,
    "",
    "# SSH 보안 설정",
    "ssh_pwauth: false",
    "",
    "write_files:",
    "  - path: /etc/ssh/sshd_config.d/99-custom.conf",
    "    content: |",
    `      Port ${sshPort}`,
    "      PermitRootLogin prohibit-password",
    "      PasswordAuthentication no",
    "      PubkeyAuthentication yes",
    "      ChallengeResponseAuthentication no",
    "      KbdInteractiveAuthentication no",
    "      UsePAM yes",
    "      X11Forwarding no",
    "      PrintMotd no",
    "      AcceptEnv LANG LC_*",
    "      Subsystem sftp /usr/lib/openssh/sftp-server",
    "",
  ];

  // 추가 디스크 포맷/마운트 스크립트
  if (extraDiskCount > 0 && extraDiskGb > 0) {
    lines.push(
      "  - path: /usr/local/bin/setup-disks.sh",
      "    permissions: '0755'",
      "    content: |",
      "      #!/bin/bash",
      "      set -u",
    );

    // scsi1, scsi2, ... 순서로 디스크 매핑
    for (let i = 0; i < extraDiskCount; i++) {
      const diskLetter = String.fromCharCode(98 + i); // sdb, sdc, sdd...
      const mountPoint = i === 0 ? "/data" : `/data${i + 1}`;

      lines.push(
        `      # Disk ${i + 1}: /dev/sd${diskLetter} → ${mountPoint}`,
        `      for _ in $(seq 1 30); do [ -b /dev/sd${diskLetter} ] && break; sleep 1; done`,
        `      if [ ! -b /dev/sd${diskLetter} ]; then`,
        `        echo "Disk /dev/sd${diskLetter} not found, skip"`,
        `      else`,
        `        TARGET_FS="${fsType}"`,
        `        ACTUAL_FS=$(blkid -s TYPE -o value /dev/sd${diskLetter} 2>/dev/null || true)`,
        `        if [ -z "$ACTUAL_FS" ]; then`,
        `          if [ "$TARGET_FS" = "xfs" ] && command -v mkfs.xfs >/dev/null 2>&1; then`,
        `            echo "Formatting /dev/sd${diskLetter} as xfs..."`,
        `            mkfs.xfs -f /dev/sd${diskLetter}`,
        `            ACTUAL_FS="xfs"`,
        `          else`,
        `            # xfs 도구가 없거나 ext4 요청인 경우 ext4로 안전하게 포맷`,
        `            echo "Formatting /dev/sd${diskLetter} as ext4..."`,
        `            mkfs.ext4 -F /dev/sd${diskLetter}`,
        `            ACTUAL_FS="ext4"`,
        `          fi`,
        `        fi`,
        `        [ -n "$ACTUAL_FS" ] || ACTUAL_FS="$TARGET_FS"`,
        `        mkdir -p ${mountPoint}`,
        `        DISK_UUID=$(blkid -s UUID -o value /dev/sd${diskLetter} 2>/dev/null || true)`,
        `        if [ -n "$DISK_UUID" ]; then`,
        `          grep -q "UUID=$DISK_UUID" /etc/fstab || echo "UUID=$DISK_UUID ${mountPoint} $ACTUAL_FS defaults,nofail 0 2" >> /etc/fstab`,
        `        else`,
        `          grep -q "^/dev/sd${diskLetter} " /etc/fstab || echo "/dev/sd${diskLetter} ${mountPoint} $ACTUAL_FS defaults,nofail 0 2" >> /etc/fstab`,
        `        fi`,
        `        mountpoint -q ${mountPoint} || mount ${mountPoint} || mount -t "$ACTUAL_FS" /dev/sd${diskLetter} ${mountPoint}`,
        `        echo "Mounted /dev/sd${diskLetter} at ${mountPoint} (fs=$ACTUAL_FS)"`,
        `      fi`,
      );
    }
  }

  // 패키지 설치
  lines.push(
    "",
    "packages:",
    "  - qemu-guest-agent",
    "  - ufw",
    "  - curl",
    "  - wget",
  );

  if (fsType === "xfs" && extraDiskCount > 0) {
    lines.push("  - xfsprogs");
  }

  // runcmd: 실행 명령
  lines.push(
    "",
    "runcmd:",
    "  # 추가 디스크 먼저 설정 (네트워크 실패와 무관하게 처리)",
  );

  if (extraDiskCount > 0 && extraDiskGb > 0) {
    lines.push("  - /usr/local/bin/setup-disks.sh || true");
  }

  lines.push(
    "",
    "  # 루트 파일시스템 확장",
    "  - growpart /dev/sda 1 || true",
    "  - resize2fs /dev/sda1 || xfs_growfs / || true",
    "",
    "  # QEMU Guest Agent 시작",
    "  - systemctl enable qemu-guest-agent",
    "  - systemctl start qemu-guest-agent",
    "",
    "  # SSH 재시작 (포트 변경 적용)",
    "  - systemctl restart ssh || systemctl restart sshd || true",
    "",
    "  # UFW 방화벽 설정",
    `  - ufw allow ${sshPort}/tcp`,
    "  - ufw --force enable",
  );

  lines.push(
    "",
    "# 초기화 완료 후 전원 상태",
    "power_state:",
    "  mode: reboot",
    "  message: Cloud-init configuration complete. Rebooting...",
    "  timeout: 30",
  );

  return lines.join("\n") + "\n";
}

/**
 * IP 주소 증가 함수
 * 예: incrementIp("10.10.2.100", 3) → "10.10.20.103"
 */
export function incrementIp(ip: string, increment: number): string {
  const parts = ip.split(".").map(Number);
  let total = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  total += increment;
  return [
    (total >>> 24) & 0xff,
    (total >>> 16) & 0xff,
    (total >>> 8) & 0xff,
    total & 0xff,
  ].join(".");
}

/**
 * IP 유효성 검사
 */
export function validateIp(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = parseInt(p);
    return !isNaN(n) && n >= 0 && n <= 255;
  });
}
