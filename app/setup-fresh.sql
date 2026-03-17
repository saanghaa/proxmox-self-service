-- ===========================================
-- Proxmox Horizon - Fresh Setup Script
-- ===========================================
-- This script resets all configuration overrides
-- and prepares the system to use default files

-- 1. Clear all configuration overrides
DELETE FROM "SystemConfig" WHERE "configKey" IN (
    'menu-config',
    'ui-strings',
    'labels-ko',
    'labels-en',
    'ui-elements'
);

-- 2. Verify cleanup
SELECT 'Configuration cleared. Remaining SystemConfig entries:' as status;
SELECT "configKey", "updatedAt" FROM "SystemConfig";

-- System will now load fresh from:
-- - defaults/default-menu-config.json
-- - defaults/ui-strings.json
-- - defaults/labels-*.json
