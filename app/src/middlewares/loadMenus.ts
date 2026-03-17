import { Request, Response, NextFunction } from "express";
import { prisma } from "../services/prisma";
import type { MenuConfig, HeaderMenuItem, PermissionLevel } from "../types/menu";
import { checkPermission } from "../types/menu";
import { getDefaultMenuConfig, mergeMenuConfigWithDefaults } from "../utils/defaultMenuConfig";
import { toLegacyFormat, getUUIDLabels, type SupportedLanguage } from "../utils/labelLoader";
import { resolveTemplate, getTemplateOptions, DEFAULT_TEMPLATE } from "../utils/themeTemplates";

/**
 * Note: Default menu config is now loaded from utils/defaultMenuConfig.ts
 * The configuration is sourced from app/defaults/default-menu-config.json
 * This eliminates hardcoded values and uses the JSON file as single source of truth.
 *
 * NEW: Section labels are now loaded from UUID-based label system
 * See: utils/labelLoader.ts and defaults/labels/*.json
 */

/**
 * DB에서 메뉴 설정 로드
 */
async function getMenuConfig(): Promise<MenuConfig> {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "menu_config" }
    });

    if (config) {
      return mergeMenuConfigWithDefaults(JSON.parse(config.value) as MenuConfig);
    }
  } catch (e) {
    console.error("[Menu] Failed to load from DB:", e);
  }

  // Fallback to JSON file-based defaults
  return getDefaultMenuConfig();
}

/**
 * 섹션 라벨 로드
 * 기본: label system (toLegacyFormat) - 버튼, 테이블 헤더, 섹션 제목 포함
 * DB에 커스텀 섹션 제목이 있으면 title/icon/description만 오버라이드
 */
async function getSectionLabels(lang: SupportedLanguage = 'ko'): Promise<any> {
  // 항상 label system에서 기본 데이터 로드 (버튼, 헤더 포함)
  let sectionLabels: any;
  try {
    sectionLabels = toLegacyFormat(lang);
  } catch (e) {
    console.error("[Menu] Failed to load from label system:", e);
    return {};
  }

  const hasHangul = (s: unknown) =>
    typeof s === "string" && /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(s);

  // DB에 커스텀 섹션 제목이 있으면 title/icon/description만 머지
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "section_labels" }
    });

    if (config) {
      const dbLabels = JSON.parse(config.value);
      for (const page of ['admin', 'dashboard']) {
        if (!dbLabels[page]) continue;
        if (!sectionLabels[page]) sectionLabels[page] = {};

        for (const [key, val] of Object.entries(dbLabels[page] as Record<string, any>)) {
          if (!val || typeof val !== 'object') continue;

          // Preserve unknown/new sections from DB as-is (e.g. vm_request, group_quota).
          if (!sectionLabels[page][key]) {
            sectionLabels[page][key] = val;
            continue;
          }

          // Existing sections: override visible metadata only.
          if (val.title) {
            const baseTitle = sectionLabels?.[page]?.[key]?.title;
            // Heuristic: prevent cross-language overrides (e.g. English title showing in Korean UI).
            // section_labels in DB is not language-scoped, so we keep the label-system's language
            // when the DB override looks like a different language.
            const shouldSkipTitleOverride =
              (lang === "ko" && hasHangul(baseTitle) && !hasHangul(val.title)) ||
              (lang === "en" && !hasHangul(baseTitle) && hasHangul(val.title));

            if (!shouldSkipTitleOverride) {
              sectionLabels[page][key].title = val.title;
            }
          }
          if (val.icon) sectionLabels[page][key].icon = val.icon;
          if (val.description !== undefined) sectionLabels[page][key].description = val.description;
        }
      }
    }
  } catch (e) {
    console.error("[Menu] Failed to load section labels from DB:", e);
  }

  return sectionLabels;
}

/**
 * 사용자 권한에 따라 메뉴 필터링
 */
function filterMenusByPermission<T extends { permission_level: PermissionLevel; is_visible: boolean; sort_order: number }>(
  menus: T[],
  userRole: "user" | "admin" | null
): T[] {
  return menus
    .filter(menu => menu.is_visible && checkPermission(menu.permission_level, userRole))
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * 현재 페이지에 맞는 메뉴만 필터링
 */
function filterMenusByPage(menus: HeaderMenuItem[], currentPage: string): HeaderMenuItem[] {
  return menus.filter(menu =>
    !menu.show_on_pages || menu.show_on_pages.includes(currentPage)
  );
}

/**
 * 모든 뷰에 메뉴 데이터를 전달하는 미들웨어
 */
export async function loadMenus(req: Request, res: Response, next: NextFunction) {
  try {
    // 언어 감지: 쿠키 > Accept-Language 헤더 > 기본값(ko)
    const cookieLang = req.cookies?.preferred_lang;
    const acceptLanguage = req.headers['accept-language'] || 'ko';

    let lang: SupportedLanguage = 'ko';
    if (cookieLang && ['ko', 'en'].includes(cookieLang)) {
      lang = cookieLang as SupportedLanguage;
    } else if (acceptLanguage.startsWith('en')) {
      lang = 'en';
    }

    const menuConfig = await getMenuConfig();
    const sectionLabels = await getSectionLabels(lang);
    const user = req.user;
    const isAdmin = user && (user as any).isAdmin;
    const userRole: "user" | "admin" | null = isAdmin ? "admin" : (user ? "user" : null);

    // 현재 페이지 감지
    const currentPage = req.path.startsWith("/admin") ? "admin" : "dashboard";

    // 권한에 따라 메뉴 필터링
    let headerMenus = filterMenusByPermission(menuConfig.header_menus, userRole);
    headerMenus = filterMenusByPage(headerMenus, currentPage);

    let sidebarMenus = filterMenusByPermission(menuConfig.sidebar_menus || [], userRole);
    // 향후 sidebar도 페이지 필터링 가능

    // Admin 탭 메뉴 (Admin 페이지에서만 사용)
    let adminTabs = filterMenusByPermission(menuConfig.admin_tabs || [], userRole);

    // 메뉴 이름을 언어별로 변경 (menu_key 기반 조회)
    const menuLabels = sectionLabels?.labels?.menus || {};
    headerMenus = headerMenus.map(menu => ({
      ...menu,
      display_name: menuLabels[menu.menu_key] || menu.display_name
    }));
    adminTabs = adminTabs.map(menu => ({
      ...menu,
      display_name: menuLabels[menu.menu_key] || menu.display_name
    }));

    // UUID 기반 라벨 로드 (폼, 모달, 메시지 등)
    const uuidLabels = getUUIDLabels(lang);

    // 테마 템플릿 로드
    // 우선순위:
    // 1) 로그인 사용자: 사용자별 저장값
    // 2) 전역 설정(theme_template)
    // 3) 비로그인 사용자: 마지막 선택 쿠키(last_theme_template)
    // 4) fallback: DEFAULT_TEMPLATE
    let activeThemeTemplate = DEFAULT_TEMPLATE;
    try {
      const globalThemeCfg = await prisma.systemConfig.findUnique({
        where: { key: "theme_template" }
      });
      const userThemeKey = user ? `theme_template_user_${user.id}` : null;
      const userThemeCfg = userThemeKey
        ? await prisma.systemConfig.findUnique({ where: { key: userThemeKey } })
        : null;

      if (userThemeCfg?.value) {
        activeThemeTemplate = resolveTemplate(userThemeCfg.value);
      } else if (globalThemeCfg?.value) {
        activeThemeTemplate = resolveTemplate(globalThemeCfg.value);
      } else if (!user) {
        activeThemeTemplate = resolveTemplate(req.cookies?.last_theme_template);
      }
    } catch {
      // DB 오류 시 기본값 유지
    }

    // res.locals에 메뉴 데이터 추가 (모든 EJS 템플릿에서 접근 가능)
    res.locals.headerMenus = headerMenus;
    res.locals.sidebarMenus = sidebarMenus;
    res.locals.adminTabs = adminTabs;
    res.locals.sectionLabels = sectionLabels;
    res.locals.uuidLabels = uuidLabels; // UUID 기반 라벨 추가
    res.locals.currentLang = lang; // 현재 언어 정보 추가
    res.locals.activeThemeTemplate = activeThemeTemplate;
    res.locals.themeTemplateOptions = getTemplateOptions();

    next();
  } catch (error) {
    console.error("[Menu Middleware Error]:", error);
    // 에러가 발생해도 기본 메뉴로 계속 진행
    res.locals.headerMenus = [];
    res.locals.sidebarMenus = [];
    res.locals.adminTabs = [];
    res.locals.sectionLabels = {};
    res.locals.uuidLabels = getUUIDLabels('ko'); // 기본 언어로 UUID 라벨 제공
    res.locals.currentLang = 'ko';
    res.locals.activeThemeTemplate = DEFAULT_TEMPLATE;
    res.locals.themeTemplateOptions = getTemplateOptions();
    next();
  }
}
