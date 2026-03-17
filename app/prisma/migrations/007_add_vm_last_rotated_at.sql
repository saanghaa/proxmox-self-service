-- Migration 007: Add lastRotatedAt field for per-VM rotation retry tracking
ALTER TABLE "Vm" ADD COLUMN IF NOT EXISTS "lastRotatedAt" TIMESTAMP(3);
