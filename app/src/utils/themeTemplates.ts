/**
 * Theme Template System
 * Manages UI theme template identifiers, validation, and option generation.
 * Templates are stored in SystemConfig under key "theme_template".
 */

export const THEME_TEMPLATES = ['proxmox', 'dark', 'indigo'] as const;
export type ThemeTemplate = typeof THEME_TEMPLATES[number];

export const DEFAULT_TEMPLATE: ThemeTemplate = 'proxmox';

export function isValidTemplate(id: string): id is ThemeTemplate {
  return (THEME_TEMPLATES as readonly string[]).includes(id);
}

export interface ThemeTemplateOption {
  id: ThemeTemplate;
  label: string;    // 한국어 레이블
  labelEn: string;  // 영어 레이블
}

/**
 * 템플릿 선택 목록 반환 (API/뷰 공통 사용)
 */
export function getTemplateOptions(): ThemeTemplateOption[] {
  return [
    { id: 'proxmox', label: 'Proxmox', labelEn: 'Proxmox' },
    { id: 'dark', label: 'Dark', labelEn: 'Dark' },
    { id: 'indigo', label: 'Indigo', labelEn: 'Indigo' },
  ];
}

/**
 * 저장된 값을 검증하여 유효하면 반환, 아니면 기본값 반환
 */
export function resolveTemplate(raw: string | null | undefined): ThemeTemplate {
  if (raw && isValidTemplate(raw)) return raw;
  return DEFAULT_TEMPLATE;
}
