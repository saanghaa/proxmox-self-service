-- VM 상태 및 동기화 필드 추가
-- running, stopped, paused, unknown
ALTER TABLE "Vm" ADD COLUMN IF NOT EXISTS "status" TEXT;
ALTER TABLE "Vm" ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3);
