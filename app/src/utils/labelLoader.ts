/**
 * Label Loader Utility
 *
 * UUID 기반 UI 요소와 다국어 라벨을 로드하고 병합합니다.
 * Single Source of Truth: ui-elements.json + labels/{lang}.json
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Default paths
// After build: __dirname = /app/dist/utils, defaults is at /app/dist/defaults
const UI_ELEMENTS_PATH = join(__dirname, '../defaults/ui-elements.json');
const LABELS_DIR = join(__dirname, '../defaults/labels');

/**
 * Supported languages
 */
export type SupportedLanguage = 'ko' | 'en';

/**
 * UI Elements structure
 */
export interface UIElements {
  version: string;
  buttons: Record<string, ButtonElement[]>;
  table_headers: Record<string, TableHeaderElement[]>;
  sections: Record<string, Record<string, SectionElement>>;
}

export interface ButtonElement {
  uuid: string;
  button_key: string;
  action?: string;
  css_class?: string;
  style?: string;
  sort_order: number;
  is_visible: boolean;
  permission_level?: string;
}

export interface TableHeaderElement {
  uuid: string;
  header_key: string;
  data_field?: string | null;
  sortable: boolean;
  sort_order: number;
  is_visible: boolean;
  css_class?: string;
  permission_level?: string;
}

export interface SectionElement {
  uuid: string;
  section_key: string;
  icon?: string;
  table?: string;
  buttons?: string;
}

/**
 * Labels structure
 */
export interface Labels {
  language: string;
  language_name: string;
  version: string;
  buttons: Record<string, string>;
  table_headers: Record<string, string>;
  sections: Record<string, { title: string; description?: string }>;
  menus: Record<string, string>;
  form_labels: Record<string, string>;
  modal_titles: Record<string, string>;
  modal_descriptions: Record<string, string>;
  placeholders: Record<string, string>;
  messages: Record<string, string>;
  confirmations: Record<string, string>;
  badges: Record<string, string>;
  notifications: Record<string, string>;
  menu_settings: Record<string, string>;
  ssh_key: Record<string, string>;
  password_generation: Record<string, string>;
}

/**
 * Merged UI Configuration (Elements + Labels)
 */
export interface MergedButton extends ButtonElement {
  display_name: string;
}

export interface MergedTableHeader extends TableHeaderElement {
  display_name: string;
}

export interface MergedSection extends SectionElement {
  title: string;
  description?: string;
}

export interface UIConfig {
  buttons: Record<string, MergedButton[]>;
  table_headers: Record<string, MergedTableHeader[]>;
  sections: Record<string, Record<string, MergedSection>>;
  labels: Labels;
}

/**
 * Cache for loaded configurations
 */
let cachedUIElements: UIElements | null = null;
let cachedLabels: Record<SupportedLanguage, Labels | null> = {
  ko: null,
  en: null,
};

/**
 * Load UI elements definition
 */
export function loadUIElements(): UIElements {
  if (cachedUIElements) {
    return cachedUIElements;
  }

  try {
    const content = readFileSync(UI_ELEMENTS_PATH, 'utf-8');
    cachedUIElements = JSON.parse(content) as UIElements;
    console.log('[LabelLoader] UI elements loaded successfully');
    return cachedUIElements;
  } catch (error) {
    console.error('[LabelLoader] Failed to load UI elements:', error);
    throw new Error('Failed to load UI elements');
  }
}

/**
 * Load labels for a specific language
 */
export function loadLabels(lang: SupportedLanguage = 'ko'): Labels {
  if (cachedLabels[lang]) {
    return cachedLabels[lang]!;
  }

  try {
    const labelPath = join(LABELS_DIR, `${lang}.json`);
    const content = readFileSync(labelPath, 'utf-8');
    cachedLabels[lang] = JSON.parse(content) as Labels;
    console.log(`[LabelLoader] Labels loaded for language: ${lang}`);
    return cachedLabels[lang]!;
  } catch (error) {
    console.error(`[LabelLoader] Failed to load labels for ${lang}:`, error);

    // Fallback to Korean if English fails
    if (lang === 'en') {
      console.warn('[LabelLoader] Falling back to Korean labels');
      return loadLabels('ko');
    }

    throw new Error(`Failed to load labels for ${lang}`);
  }
}

/**
 * Merge UI elements with labels to create final configuration
 */
export function getUIConfig(lang: SupportedLanguage = 'ko'): UIConfig {
  const elements = loadUIElements();
  const labels = loadLabels(lang);

  // Merge buttons: lookup by button_key
  const mergedButtons: Record<string, MergedButton[]> = {};
  for (const [section, buttons] of Object.entries(elements.buttons)) {
    mergedButtons[section] = buttons.map(btn => ({
      ...btn,
      display_name: labels.buttons[btn.button_key] || btn.button_key,
    }));
  }

  // Merge table headers: lookup by header_key
  const mergedHeaders: Record<string, MergedTableHeader[]> = {};
  for (const [section, headers] of Object.entries(elements.table_headers)) {
    mergedHeaders[section] = headers.map(hdr => ({
      ...hdr,
      display_name: labels.table_headers[hdr.header_key] || hdr.header_key,
    }));
  }

  // Merge sections: lookup by section_key
  const mergedSections: Record<string, Record<string, MergedSection>> = {};
  for (const [page, sections] of Object.entries(elements.sections)) {
    mergedSections[page] = {};
    for (const [key, section] of Object.entries(sections)) {
      const sectionLabels = labels.sections[section.section_key] || { title: section.section_key };
      mergedSections[page][key] = {
        ...section,
        title: sectionLabels.title,
        description: sectionLabels.description,
      };
    }
  }

  return {
    buttons: mergedButtons,
    table_headers: mergedHeaders,
    sections: mergedSections,
    labels,
  };
}

/**
 * Get button configuration by section
 */
export function getButtons(section: string, lang: SupportedLanguage = 'ko'): MergedButton[] {
  const config = getUIConfig(lang);
  return config.buttons[section] || [];
}

/**
 * Get table headers by section
 */
export function getTableHeaders(section: string, lang: SupportedLanguage = 'ko'): MergedTableHeader[] {
  const config = getUIConfig(lang);
  return config.table_headers[section] || [];
}

/**
 * Get section configuration
 */
export function getSection(page: string, section: string, lang: SupportedLanguage = 'ko'): MergedSection | null {
  const config = getUIConfig(lang);
  return config.sections[page]?.[section] || null;
}

/**
 * Get all labels (for client-side use)
 */
export function getAllLabels(lang: SupportedLanguage = 'ko'): Labels {
  return loadLabels(lang);
}

/**
 * Clear cache (useful for hot-reloading in development)
 */
export function clearCache(): void {
  cachedUIElements = null;
  cachedLabels = { ko: null, en: null };
  console.log('[LabelLoader] Cache cleared');
}

/**
 * Helper: Get label by UUID
 */
export function getLabel(uuid: string, category: keyof Labels, lang: SupportedLanguage = 'ko'): string {
  const labels = loadLabels(lang);
  const categoryLabels = labels[category] as any;

  if (typeof categoryLabels === 'object' && categoryLabels !== null) {
    return categoryLabels[uuid] || uuid;
  }

  return uuid;
}

/**
 * Get UUID-based UI labels (form labels, modals, placeholders, etc.)
 * These are the new UUID-based elements for complete UI coverage
 */
export interface UUIDLabels {
  formLabels: Record<string, string>;
  modalTitles: Record<string, string>;
  modalDescriptions: Record<string, string>;
  placeholders: Record<string, string>;
  buttonCommon: Record<string, string>;
  messages: Record<string, string>;
  confirmations: Record<string, string>;
  badges: Record<string, string>;
  notifications: Record<string, string>;
  menuSettings: Record<string, string>;
  sshKey: Record<string, string>;
  passwordGeneration: Record<string, string>;
}

/**
 * Build UUID → value mapping from ui-elements (UUID→key) + labels (key→value)
 */
function buildUUIDMapping(
  elementArray: any[],
  keyField: string,
  labelObj: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(elementArray)) {
    for (const el of elementArray) {
      result[el.uuid] = labelObj[el[keyField]] || el[keyField];
    }
  }
  return result;
}

/**
 * Load UUID-based labels by resolving through ui-elements.json mappings
 * EJS templates use UUID keys (e.g., 'lbl-001'), which are resolved to
 * semantic keys (e.g., 'EMAIL') via ui-elements, then to values via labels.
 */
export function getUUIDLabels(lang: SupportedLanguage = 'ko'): UUIDLabels {
  const labels = loadLabels(lang) as any;
  const elements = loadUIElements() as any;

  return {
    formLabels: buildUUIDMapping(elements.form_labels, 'label_key', labels.form_labels || {}),
    modalTitles: buildUUIDMapping(elements.modal_titles, 'modal_key', labels.modal_titles || {}),
    modalDescriptions: buildUUIDMapping(elements.modal_descriptions, 'description_key', labels.modal_descriptions || {}),
    placeholders: buildUUIDMapping(elements.placeholders, 'placeholder_key', labels.placeholders || {}),
    buttonCommon: buildUUIDMapping(elements.button_common, 'button_key', labels.buttons || {}),
    messages: buildUUIDMapping(elements.messages, 'message_key', labels.messages || {}),
    confirmations: buildUUIDMapping(elements.confirmations, 'confirmation_key', labels.confirmations || {}),
    badges: buildUUIDMapping(elements.badges, 'badge_key', labels.badges || {}),
    notifications: buildUUIDMapping(elements.notifications, 'notification_key', labels.notifications || {}),
    menuSettings: buildUUIDMapping(elements.menu_settings, 'setting_key', labels.menu_settings || {}),
    sshKey: buildUUIDMapping(elements.ssh_key, 'ssh_key_key', labels.ssh_key || {}),
    passwordGeneration: buildUUIDMapping(elements.password_generation, 'password_key', labels.password_generation || {}),
  };
}

/**
 * Convert to legacy format for backward compatibility
 * This allows gradual migration from old system to new UUID-based system
 */
export function toLegacyFormat(lang: SupportedLanguage = 'ko'): any {
  const config = getUIConfig(lang);
  const labels = config.labels;

  const isEnglish = lang === 'en';
  const fallback = (en: string, ko: string) => (isEnglish ? en : ko);

  return {
    admin: {
      user_management: {
        title: config.sections.admin?.user_management?.title || fallback('User Management', '사용자 관리'),
        icon: config.sections.admin?.user_management?.icon,
        description: config.sections.admin?.user_management?.description,
        table_headers: config.table_headers.user_management || [],
        buttons: config.buttons.user_management || [],
      },
      group_management: {
        title: config.sections.admin?.group_management?.title || fallback('Group Management', '그룹 관리'),
        icon: config.sections.admin?.group_management?.icon,
        description: config.sections.admin?.group_management?.description,
        table_headers: config.table_headers.group_management || [],
        buttons: config.buttons.group_management || [],
      },
      vm_management: {
        title: config.sections.admin?.vm_management?.title || fallback('VM Management', 'VM 관리'),
        icon: config.sections.admin?.vm_management?.icon,
        description: config.sections.admin?.vm_management?.description,
        table_headers: config.table_headers.vm_management || [],
        buttons: config.buttons.vm_management || [],
      },
      notification_settings: {
        title: config.sections.admin?.notification_settings?.title || fallback('Notifications', '알림'),
        icon: config.sections.admin?.notification_settings?.icon,
        description: config.sections.admin?.notification_settings?.description,
        buttons: config.buttons.notifications || [],
      },
      password_policy: {
        title: config.sections.admin?.password_policy?.title || fallback('Password Policy', '비밀번호 정책'),
        icon: config.sections.admin?.password_policy?.icon,
        description: config.sections.admin?.password_policy?.description,
        buttons: config.buttons.password_policy || [],
      },
      audit_logs: {
        title: config.sections.admin?.audit_logs?.title || fallback('Audit Logs', '감사 로그'),
        icon: config.sections.admin?.audit_logs?.icon,
        description: config.sections.admin?.audit_logs?.description,
        table_headers: config.table_headers.audit_logs || [],
        buttons: config.buttons.audit_logs || [],
      },
      menu_settings: {
        title: config.sections.admin?.menu_settings?.title || fallback('Menu Settings', '메뉴 설정'),
        icon: config.sections.admin?.menu_settings?.icon,
        description: config.sections.admin?.menu_settings?.description,
        buttons: config.buttons.menu_settings || [],
      },
    },
    dashboard: {
      my_groups: {
        title: config.sections.dashboard?.my_groups?.title || fallback('My Groups', '내 그룹'),
        icon: config.sections.dashboard?.my_groups?.icon,
        description: config.sections.dashboard?.my_groups?.description,
      },
      jobs_vms: {
        title: config.sections.dashboard?.jobs_vms?.title || fallback('Jobs & VMs', '작업 및 VM'),
        icon: config.sections.dashboard?.jobs_vms?.icon,
        description: config.sections.dashboard?.jobs_vms?.description,
        table_headers: config.table_headers.dashboard_vms || [],
        buttons: config.buttons.dashboard || [],
      },
      vm_request_history: {
        title: config.sections.dashboard?.vm_request_history?.title || fallback('VM Create History', 'VM 생성 요청 내역'),
        icon: config.sections.dashboard?.vm_request_history?.icon,
        description: config.sections.dashboard?.vm_request_history?.description,
        table_headers: config.table_headers.dashboard_vm_request_history || [],
      },
    },
    labels,
  };
}
