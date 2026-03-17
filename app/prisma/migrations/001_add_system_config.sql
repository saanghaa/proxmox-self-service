-- CreateTable
CREATE TABLE IF NOT EXISTS "SystemConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SystemConfig_key_key" ON "SystemConfig"("key");

-- Insert default password policy
INSERT INTO "SystemConfig" ("id", "key", "value", "updatedAt", "createdAt")
VALUES (
    gen_random_uuid()::text,
    'password_policy',
    '{"expiryDays":90,"warningDays":7,"minLength":8,"complexity":{"requireUppercase":true,"requireLowercase":true,"requireNumbers":true,"requireSpecialChars":true}}',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
