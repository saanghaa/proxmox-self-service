-- Add soft delete fields to Vm table
ALTER TABLE "Vm" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Vm" ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;

-- Create index on deletedAt for performance
CREATE INDEX IF NOT EXISTS "Vm_deletedAt_idx" ON "Vm"("deletedAt");
