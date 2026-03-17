/**
 * 기본 메뉴 설정 로더
 *
 * JSON 파일에서 기본 메뉴 설정을 로드합니다.
 * 이 파일이 단일 진실 공급원(Single Source of Truth)입니다.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { MenuConfig } from '../types/menu';

// JSON 파일 경로 결정
// Dev mode: __dirname = /app/src/utils, defaults is at /app/defaults (go up 2 levels)
// After build: __dirname = /app/dist/utils, defaults is at /app/dist/defaults (go up 1 level)
function getConfigPath(): string {
  const isDist = __dirname.includes('dist');
  const relativePath = isDist ? '../defaults/default-menu-config.json' : '../../defaults/default-menu-config.json';
  return resolve(join(__dirname, relativePath));
}

const DEFAULT_CONFIG_PATH = getConfigPath();

/**
 * 기본 메뉴 설정을 JSON 파일에서 로드
 *
 * @returns MenuConfig - 기본 메뉴 설정
 * @throws Error - JSON 파일을 읽거나 파싱할 수 없는 경우
 */
export function loadDefaultMenuConfig(): MenuConfig {
  console.log('[Menu] __dirname:', __dirname);
  console.log('[Menu] Attempting to load from:', DEFAULT_CONFIG_PATH);

  // 파일 존재 여부 확인
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    console.error('[Menu] ❌ Config file not found at:', DEFAULT_CONFIG_PATH);
    console.error('[Menu] Using emergency fallback config');
    return getEmergencyFallback();
  }

  try {
    const jsonContent = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(jsonContent) as MenuConfig;

    console.log('[Menu] ✅ Successfully loaded default config from JSON file');
    console.log('[Menu] Config has', config.admin_tabs?.length || 0, 'admin tabs');

    // 중요 메뉴 확인
    const deletedVmMenu = config.admin_tabs?.find(t => t.menu_key === 'DELETED_VM_MANAGEMENT');
    const groupMenu = config.admin_tabs?.find(t => t.menu_key === 'GROUP_MANAGEMENT');
    console.log('[Menu] "삭제된 VM" menu name:', deletedVmMenu?.display_name);
    console.log('[Menu] "그룹" menu name:', groupMenu?.display_name);

    return config;
  } catch (error) {
    console.error('[Menu] ❌ Failed to parse config file:', error);
    return getEmergencyFallback();
  }
}

function getEmergencyFallback(): MenuConfig {

  // 최소한의 폴백 (JSON 파일 손상 시에만 사용)
  console.warn('[Menu] ⚠️  Using minimal emergency fallback');
  return {
      header_menus: [
        {
          uuid: "550e8400-e29b-41d4-a716-446655440001",
          menu_key: "DASHBOARD",
          display_name: "Dashboard",
          icon: "🏠",
          path: "/",
          parent_uuid: null,
          permission_level: "USER",
          sort_order: 1,
          is_visible: true,
          show_on_pages: ["admin"]
        },
        {
          uuid: "550e8400-e29b-41d4-a716-446655440003",
          menu_key: "LOGOUT",
          display_name: "Logout",
          icon: "🚪",
          path: "/auth/logout",
          parent_uuid: null,
          permission_level: "USER",
          sort_order: 99,
          is_visible: true,
          show_on_pages: ["dashboard", "admin"]
        }
      ],
      admin_tabs: [
        {
          uuid: "a1b2c3d4-e5f6-41d4-a716-446655440011",
          menu_key: "USER_MANAGEMENT",
          display_name: "Users",
          icon: "👥",
          tab_id: "tab-users",
          parent_uuid: null,
          permission_level: "ADMIN_ONLY",
          sort_order: 1,
          is_visible: true
        }
      ],
      sidebar_menus: []
    };
}

function mergeMenuItemsByKey<T extends { menu_key: string; sort_order: number }>(
  currentItems: T[] = [],
  defaultItems: T[] = []
): T[] {
  const merged = new Map<string, T>();

  currentItems.forEach((item) => {
    merged.set(item.menu_key, item);
  });

  defaultItems.forEach((item) => {
    if (!merged.has(item.menu_key)) {
      merged.set(item.menu_key, item);
    }
  });

  return Array.from(merged.values()).sort((a, b) => a.sort_order - b.sort_order);
}

export function mergeMenuConfigWithDefaults(config: MenuConfig): MenuConfig {
  const defaults = getDefaultMenuConfig();

  return {
    header_menus: mergeMenuItemsByKey(config.header_menus || [], defaults.header_menus || []),
    admin_tabs: mergeMenuItemsByKey(config.admin_tabs || [], defaults.admin_tabs || []),
    sidebar_menus: mergeMenuItemsByKey(config.sidebar_menus || [], defaults.sidebar_menus || []),
  };
}

/**
 * 기본 메뉴 설정을 캐싱된 형태로 가져오기
 * 서버 시작 시 한 번만 로드하여 성능 향상
 */
let cachedConfig: MenuConfig | null = null;

export function getDefaultMenuConfig(): MenuConfig {
  if (!cachedConfig) {
    cachedConfig = loadDefaultMenuConfig();
  }
  return cachedConfig;
}
