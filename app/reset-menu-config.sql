-- Reset UI bootstrap config in DB to force reload from defaults
-- Source files:
-- - app/defaults/default-menu-config.json
-- - app/defaults/default-section-labels.json
DELETE FROM "SystemConfig"
WHERE "key" IN ('menu_config', 'section_labels');
