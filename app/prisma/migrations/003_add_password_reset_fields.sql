-- Add password reset fields to User table
-- These fields support temporary password functionality for password reset flow

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tempPasswordSetAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tempPasswordExpiry" TIMESTAMP(3);

-- Comments for documentation
COMMENT ON COLUMN "User"."tempPasswordSetAt" IS '임시 비밀번호가 발급된 시각 (Password Reset)';
COMMENT ON COLUMN "User"."tempPasswordExpiry" IS '임시 비밀번호 만료 시각 (기본 24시간)';
