/**
 * 메뉴 시스템 타입 정의
 * UUID 기반의 동적 메뉴 구조
 */

/**
 * 권한 레벨
 */
export type PermissionLevel =
  | "PUBLIC"           // 모든 사용자 (로그인 불필요)
  | "USER"             // 로그인한 일반 사용자
  | "ADMIN_ONLY";      // 관리자만

/**
 * 메뉴 키 (개발자 식별용)
 * 코드에서 특정 메뉴를 참조할 때 사용
 */
export type MenuKey =
  // Header Menus
  | "DASHBOARD"
  | "ADMIN_PANEL"
  | "CHANGE_PASSWORD"
  | "LOGOUT"
  // Admin Tabs
  | "VM_REQUESTS"
  | "USER_MANAGEMENT"
  | "GROUP_MANAGEMENT"
  | "GROUP_QUOTA"
  | "VM_MANAGEMENT"
  | "DELETED_VM_MANAGEMENT"
  | "NOTIFICATION_SETTINGS"
  | "PASSWORD_POLICY"
  | "AUDIT_LOGS"
  | "MENU_SETTINGS"
  | "UI_SETTINGS"
  | "PROXMOX_CONNECTION"
  // Sidebar Menus (Future)
  | "MY_PROFILE"
  | "SETTINGS";

/**
 * 기본 메뉴 아이템 인터페이스
 */
export interface BaseMenuItem {
  uuid: string;                      // UUID v4 고유 식별자
  menu_key: MenuKey;                 // 개발자 식별용 키
  display_name: string;              // 사용자에게 표시되는 이름
  icon?: string;                     // 아이콘 (emoji or icon class name)
  parent_uuid?: string | null;       // 부모 메뉴 UUID (계층 구조)
  permission_level: PermissionLevel; // 접근 권한
  sort_order: number;                // 정렬 순서 (order → sort_order로 통일)
  is_visible: boolean;               // 표시 여부 (visible → is_visible로 통일)
  description?: string;              // 메뉴 설명 (툴팁 등에 사용)
}

/**
 * 헤더 메뉴 아이템 (페이지 이동용)
 */
export interface HeaderMenuItem extends BaseMenuItem {
  path: string;                      // 라우트 경로
  css_class?: string;                // 추가 CSS 클래스
  show_on_pages?: string[];          // 특정 페이지에서만 표시 ["dashboard", "admin"]
}

/**
 * Admin 탭 메뉴 아이템
 */
export interface AdminTabMenuItem extends BaseMenuItem {
  tab_id: string;  // 탭 콘텐츠 ID (예: "tab-users", "tab-groups")
}

/**
 * 사이드바 메뉴 아이템 (향후 확장용)
 */
export interface SidebarMenuItem extends BaseMenuItem {
  path: string;
  badge?: string;                    // 배지 텍스트 (예: "New", "3")
  badge_color?: string;              // 배지 색상
}

/**
 * 전체 메뉴 설정
 */
export interface MenuConfig {
  header_menus: HeaderMenuItem[];
  admin_tabs: AdminTabMenuItem[];
  sidebar_menus: SidebarMenuItem[];
}

/**
 * 버튼 키 (개발자 식별용)
 * 동적 버튼을 코드에서 참조할 때 사용
 */
export type ButtonKey =
  // User Management Buttons
  | "EXPORT_CSV"
  | "ADD_USER"
  | "ENABLE_ADMIN"
  | "DISABLE_ADMIN"
  | "CHANGE_GROUP"
  | "PW_RESET"
  | "OTP_RESET"
  | "ACTIVATE"
  | "DEACTIVATE"
  | "DELETE"
  | "EXPORT_ALL_VMS_CSV"
  | "EXPORT_MY_VMS"
  // Group Management Buttons
  | "ADD_GROUP"
  | "ADD_MEMBER"
  | "EDIT"
  | "REMOVE"
  | "DELETE_GROUP"
  // VM Management Buttons
  | "RESTORE"
  | "ADD_EXISTING_VM"
  | "DOWNLOAD_KEY"
  | "ASSIGN_JOB"
  | "DELETE_VM"
  // Audit Logs Buttons
  | "EXPORT_AUDIT"
  // VM Request Buttons
  | "APPROVE"
  | "REJECT"
  | "REVIEW"
  // Common Buttons
  | "SAVE_POLICY"
  | "SAVE_SLACK"
  | "TEST_SLACK"
  | "SAVE_TEAMS"
  | "TEST_TEAMS"
  | "SAVE_EMAIL"
  | "TEST_EMAIL"
  | "SAVE_WEBHOOK"
  | "TEST_WEBHOOK"
  | "SAVE_MENU_CONFIG"
  | "CANCEL"
  | "CREATE"
  | "UPDATE"
  | "SAVE"
  | "CLOSE"
  | "SUBMIT"
  | "VERIFY"
  | "DOWNLOAD"
  | "UPLOAD"
  | "ADD"
  | "ASSIGN"
  | "RESET";

/**
 * 테이블 헤더 키 (개발자 식별용)
 */
export type HeaderKey =
  // User Management Headers
  | "EMAIL"
  | "STATUS"
  | "ADMIN"
  | "OTP"
  | "GROUPS"
  | "CREATED"
  | "ACTIONS"
  // Group Management Headers
  | "GROUP_NAME"
  | "MEMBERS"
  // VM Management Headers
  | "VMID"
  | "HOSTNAME"
  | "IP_ADDRESS"
  | "GROUP"
  | "JOB_ID"
  | "SSH_KEY"
  | "VM_STATUS"
  // VM Request Headers
  | "REQUEST_DATE"
  | "REQUEST_TYPE"
  | "VM_COUNT"
  | "SPEC"
  | "PURPOSE"
  // Audit Logs Headers
  | "TIMESTAMP"
  | "USER"
  | "ACTION"
  | "RESULT"
  | "DETAILS"
  | "IP";

/**
 * 버튼 설정 인터페이스
 */
export interface ButtonConfig {
  uuid: string;                      // UUID v4 고유 식별자
  button_key: ButtonKey;             // 개발자 식별용 키
  display_name: string;              // 사용자에게 표시되는 텍스트
  action?: string;                   // 클릭 시 실행할 JavaScript 함수명
  css_class?: string;                // CSS 클래스
  icon?: string;                     // 아이콘
  sort_order: number;                // 정렬 순서
  is_visible: boolean;               // 표시 여부
  permission_level?: PermissionLevel;// 접근 권한 (optional)
  description?: string;              // 버튼 설명 (툴팁용)
}

/**
 * 테이블 헤더 설정 인터페이스
 */
export interface TableHeaderConfig {
  uuid: string;                      // UUID v4 고유 식별자
  header_key: HeaderKey;             // 개발자 식별용 키
  display_name: string;              // 사용자에게 표시되는 텍스트
  sortable: boolean;                 // 정렬 가능 여부
  data_field?: string;               // 정렬에 사용할 데이터 필드명
  sort_order: number;                // 정렬 순서
  is_visible: boolean;               // 표시 여부
  css_class?: string;                // CSS 클래스
  description?: string;              // 헤더 설명 (툴팁용)
}

/**
 * 섹션 라벨 설정 인터페이스
 */
export interface SectionLabelConfig {
  title: string;                     // 섹션 제목
  icon?: string;                     // 섹션 아이콘
  description?: string;              // 섹션 설명
  table_headers: TableHeaderConfig[];// 테이블 헤더 설정 (UUID 방식)
  buttons: ButtonConfig[];           // 버튼 설정 (UUID 방식)
}

/**
 * 전체 섹션 라벨 설정
 */
export interface SectionLabelsConfig {
  admin: {
    [sectionKey: string]: SectionLabelConfig;
  };
}

/**
 * 하드코딩 제거됨!
 * 이제 각 메뉴 아이템의 path 필드를 직접 사용합니다.
 * MENU_KEY_TO_TAB_ID 매핑은 더 이상 필요하지 않습니다.
 */

/**
 * 권한 레벨에 따른 Express user role 매핑
 */
export function checkPermission(
  permissionLevel: PermissionLevel,
  userRole: "user" | "admin" | null
): boolean {
  switch (permissionLevel) {
    case "PUBLIC":
      return true;
    case "USER":
      return userRole !== null;
    case "ADMIN_ONLY":
      return userRole === "admin";
    default:
      return false;
  }
}
