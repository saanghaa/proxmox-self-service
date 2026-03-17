-- Migration 008: VmDisk 테이블 추가 (디스크별 개별 관리)
-- diskSizeGb = 전체 합계 캐시로 변경 (scsi0만 → 전체 합산)
-- extraDisksGb 컬럼은 추가되지 않음 (VmDisk로 대체)

CREATE TABLE IF NOT EXISTS "VmDisk" (
  "id"       TEXT NOT NULL,
  "vmId"     TEXT NOT NULL,
  "slot"     TEXT NOT NULL,   -- "scsi0", "scsi1", "virtio0", "sata0" 등
  "sizeGb"   INTEGER NOT NULL,
  "storage"  TEXT,            -- "pve-pool", "local-zfs" 등
  CONSTRAINT "VmDisk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VmDisk_vmId_slot_key" UNIQUE ("vmId", "slot"),
  CONSTRAINT "VmDisk_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "Vm"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "VmDisk_vmId_idx" ON "VmDisk"("vmId");
