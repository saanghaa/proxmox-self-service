-- 섹션 제목 및 라벨 설정 추가
-- 페이지별 섹션 제목을 동적으로 관리합니다

INSERT INTO "SystemConfig" (id, key, value, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'section_labels',
  '{
    "dashboard": {
      "my_groups": {
        "title": "My Groups",
        "icon": "👥",
        "description": "Groups you are a member of"
      },
      "jobs_vms": {
        "title": "Jobs & VMs",
        "icon": "💻",
        "description": "Virtual machines and deployment jobs"
      }
    },
    "admin": {
      "user_management": {
        "title": "User Management",
        "icon": "👤",
        "description": "Manage user accounts and permissions"
      },
      "group_management": {
        "title": "Group Management",
        "icon": "🏢",
        "description": "Manage groups and memberships"
      },
      "vm_management": {
        "title": "VM Management",
        "icon": "💻",
        "description": "Manage virtual machines"
      },
      "notification_settings": {
        "title": "Notification Settings",
        "icon": "🔔",
        "description": "Configure notification channels"
      },
      "password_policy": {
        "title": "Password Policy",
        "icon": "🔒",
        "description": "Configure password requirements"
      },
      "audit_logs": {
        "title": "Audit Logs",
        "icon": "📋",
        "description": "View system activity logs"
      },
      "menu_settings": {
        "title": "Menu Settings",
        "icon": "⚙️",
        "description": "Configure menus and navigation"
      }
    }
  }',
  NOW(),
  NOW()
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  "updatedAt" = NOW();
