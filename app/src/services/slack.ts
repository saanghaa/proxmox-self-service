/**
 * 통합 알림 서비스
 * Slack, Teams, Email, Custom Webhook 지원
 */

import { prisma } from "./prisma";

interface SlackMessage {
  text?: string;
  blocks?: any[];
  attachments?: any[];
}

interface NotificationConfig {
  slack?: {
    enabled: boolean;
    webhookUrl: string;
    events?: string[];
  };
  teams?: {
    enabled: boolean;
    webhookUrl: string;
    events?: string[];
  };
  email?: {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPassword: string;
    from: string;
    to: string[];
    events?: string[];
  };
  webhook?: {
    enabled: boolean;
    url: string;
    headers?: Record<string, string>;
    events?: string[];
  };
}

export const NOTIFICATION_EVENT_KEYS = [
  "key_download",
  "vm_delete",
  "vm_restore",
  "vm_permanent_delete",
  "vm_change_group",
  "vm_request_create",
  "vm_request_cancel",
  "vm_request_approve",
  "vm_request_reject",
  "vm_request_approve_quota",
  "vm_request_deploy",
  "vm_request_retry_deploy",
  "deploy_completed",
  "login_success",
  "login_fail",
  "otp_recovery_used",
  "user_reset_otp",
  "otp_enroll_completed",
  "otp_setup_completed",
  "password_reset_request",
  "password_changed",
  "user_create",
  "user_deactivate",
  "user_activate",
  "user_delete",
  "user_reset_password",
  "group_update",
  "group_delete",
  "group_quota_update",
  "notification_config_update",
  "menu_config_update",
  "section_labels_update",
  "ui_elements_update",
  "labels_update",
  "ui_strings_update",
  "ui_strings_reset",
  "key_rotate",
  "key_rotate_auto",
  "backup_created",
  "backup_failed",
  "backup_restored",
  "backup_schedule_update",
  // legacy aliases
  "vm_deletion",
  "vm_group_change",
] as const;
type NotificationEventType = typeof NOTIFICATION_EVENT_KEYS[number] | string;

/**
 * DB에서 알림 설정 가져오기
 */
async function getNotificationConfig(): Promise<NotificationConfig> {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "notification_config" }
    });

    if (config) {
      return JSON.parse(config.value);
    }
  } catch (e) {
    console.error("[Notification] Failed to load config:", e);
  }

  return {}; // 빈 설정 반환
}

/**
 * Slack 웹훅으로 메시지 전송
 */
async function sendSlackMessage(webhookUrl: string, message: SlackMessage): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error(`[Slack] Failed to send message: ${response.statusText}`);
    }
  } catch (error) {
    console.error("[Slack] Error sending message:", error);
  }
}

/**
 * Teams 웹훅으로 메시지 전송
 */
async function sendTeamsMessage(webhookUrl: string, message: any): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error(`[Teams] Failed to send message: ${response.statusText}`);
    }
  } catch (error) {
    console.error("[Teams] Error sending message:", error);
  }
}

/**
 * Custom Webhook으로 메시지 전송
 */
async function sendWebhookMessage(url: string, payload: any, headers?: Record<string, string>): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[Webhook] Failed to send message: ${response.statusText}`);
    }
  } catch (error) {
    console.error("[Webhook] Error sending message:", error);
  }
}

/**
 * 모든 활성화된 채널로 알림 전송
 */
function isEventEnabled(
  channelConfig: { events?: string[] } | undefined,
  eventType: string
): boolean {
  if (!channelConfig || !Array.isArray(channelConfig.events)) {
    // Missing events list means "all events" (backward-compatible default behavior).
    return true;
  }
  if (channelConfig.events.includes(eventType)) return true;

  // Backward compatibility:
  // existing installations may still have the legacy 3-event set saved in DB.
  // In that case, keep login success notifications enabled by default.
  if (eventType === "login_success") {
    const legacyEvents = ["key_download", "vm_deletion", "vm_group_change"];
    const looksLegacyOnly = channelConfig.events.every((e) => legacyEvents.includes(e));
    if (looksLegacyOnly) return true;
  }

  return false;
}

async function sendNotification(
  eventType: string,
  slackMessage: SlackMessage,
  teamsMessage: any,
  genericPayload: any
): Promise<void> {
  const config = await getNotificationConfig();

  // Slack 알림
  if (config.slack?.enabled && config.slack.webhookUrl && isEventEnabled(config.slack, eventType)) {
    await sendSlackMessage(config.slack.webhookUrl, slackMessage);
  }

  // Teams 알림
  if (config.teams?.enabled && config.teams.webhookUrl && isEventEnabled(config.teams, eventType)) {
    await sendTeamsMessage(config.teams.webhookUrl, teamsMessage);
  }

  // Custom Webhook 알림
  if (config.webhook?.enabled && config.webhook.url && isEventEnabled(config.webhook, eventType)) {
    await sendWebhookMessage(config.webhook.url, genericPayload, config.webhook.headers);
  }

  // Email 알림은 향후 구현 (nodemailer 사용)
  // if (config.email?.enabled) { ... }
}



function toActionLabel(action: string): string {
  const map: Record<string, string> = {
    KEY_DOWNLOAD: "SSH 키 다운로드",
    VM_DELETE: "VM 삭제",
    VM_RESTORE: "VM 복구",
    VM_PERMANENT_DELETE: "VM 영구 삭제",
    VM_CHANGE_GROUP: "VM 그룹 변경",
    VM_REQUEST_CREATE: "VM 생성 요청",
    VM_REQUEST_CANCEL: "VM 요청 취소",
    VM_REQUEST_APPROVE: "VM 요청 승인",
    VM_REQUEST_REJECT: "VM 요청 반려",
    VM_REQUEST_APPROVE_QUOTA: "VM 쿼터 승인",
    VM_REQUEST_DEPLOY: "VM 배포 시작",
    VM_REQUEST_RETRY_DEPLOY: "VM 재배포 시작",
    DEPLOY_COMPLETED: "배포 완료",
    DEPLOY_PARTIAL: "배포 부분 완료",
    DEPLOY_FAILED: "배포 실패",
    LOGIN_SUCCESS: "로그인 성공",
    LOGIN_FAIL: "로그인 실패",
    OTP_ENROLL_COMPLETED: "OTP 등록 완료",
    OTP_SETUP_COMPLETED: "OTP 등록 완료",
    OTP_RECOVERY_USED: "OTP 복구코드 사용",
    PASSWORD_RESET_REQUEST: "비밀번호 재설정 요청",
    PASSWORD_CHANGED: "비밀번호 변경",
    USER_CREATE: "사용자 생성",
    USER_DEACTIVATE: "사용자 비활성화",
    USER_ACTIVATE: "사용자 활성화",
    USER_DELETE: "사용자 삭제",
    USER_RESET_PASSWORD: "사용자 비밀번호 초기화",
    USER_RESET_OTP: "사용자 OTP 초기화",
    GROUP_UPDATE: "그룹 수정",
    GROUP_DELETE: "그룹 삭제",
    GROUP_QUOTA_UPDATE: "그룹 쿼터 수정",
    NOTIFICATION_CONFIG_UPDATE: "알림 설정 변경",
    MENU_CONFIG_UPDATE: "메뉴 설정 변경",
    SECTION_LABELS_UPDATE: "섹션 라벨 변경",
    UI_ELEMENTS_UPDATE: "UI 요소 변경",
    LABELS_UPDATE: "레이블 변경",
    UI_STRINGS_UPDATE: "문구 설정 변경",
    UI_STRINGS_RESET: "문구 설정 초기화",
    KEY_ROTATE: "SSH 키 교체 (수동)",
    KEY_ROTATE_AUTO: "SSH 키 교체 (자동)",
    WIN_PW_ROTATE_AUTO: "Windows 비밀번호 교체 (자동)",
    AUTO_ROTATE: "자동 교체 실행",
    BACKUP_CREATED: "백업 생성",
    BACKUP_FAILED: "백업 실패",
    BACKUP_RESTORED: "백업 복구",
    BACKUP_SCHEDULE_UPDATE: "백업 스케줄 변경",
  };
  return map[action] || action;
}

export async function notifyAuditEvent(params: {
  action: string;
  result: string;
  userEmail?: string;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
  keyVersion?: string;
  fingerprint?: string;
  vmHostname?: string;
  vmid?: number;
  groupName?: string;
  oldGroupName?: string;
  newGroupName?: string;
}): Promise<void> {
  const action = String(params.action || "").toUpperCase();
  const eventType = action.toLowerCase();
  const result = String(params.result || "").toUpperCase();
  const isKeyDownload = action === "KEY_DOWNLOAD" && result === "SUCCESS";

  const icon = isKeyDownload ? "🔑" : result === "SUCCESS" ? "✅" : "⚠️";
  const actionLabel = isKeyDownload ? "SSH Key Downloaded" : toActionLabel(action);
  const themeColor = isKeyDownload ? "0078D4" : result === "SUCCESS" ? "107C10" : "D13438";

  const slackFields = isKeyDownload
    ? [
        { type: "mrkdwn", text: `*User:*\n${params.userEmail || "N/A"}` },
        { type: "mrkdwn", text: `*Key Version:*\n${params.keyVersion || "N/A"}` },
        { type: "mrkdwn", text: `*VM:*\n${params.vmHostname || "N/A"}` },
        { type: "mrkdwn", text: `*IP Address:*\n${params.ipAddress || "N/A"}` },
      ]
    : [
        { type: "mrkdwn", text: `*이벤트:*\n${action}` },
        { type: "mrkdwn", text: `*결과:*\n${result}` },
        { type: "mrkdwn", text: `*사용자:*\n${params.userEmail || "N/A"}` },
        { type: "mrkdwn", text: `*IP:*\n${params.ipAddress || "N/A"}` },
      ];

  const teamsFacts = isKeyDownload
    ? [
        { name: "User", value: params.userEmail || "N/A" },
        { name: "Key Version", value: params.keyVersion || "N/A" },
        { name: "VM", value: params.vmHostname || "N/A" },
        { name: "IP Address", value: params.ipAddress || "N/A" },
      ]
    : [
        { name: "이벤트", value: action },
        { name: "결과", value: result },
        { name: "사용자", value: params.userEmail || "N/A" },
        { name: "IP", value: params.ipAddress || "N/A" },
        ...(params.reason ? [{ name: "상세", value: params.reason }] : []),
      ];

  const slackContext = isKeyDownload && params.fingerprint
    ? `Fingerprint: \`${params.fingerprint.substring(0, 16)}...\``
    : `User-Agent: ${String(params.userAgent || "N/A").slice(0, 120)}`;

  const slackMessage: SlackMessage = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${icon} ${actionLabel}`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: slackFields,
      },
      ...(!isKeyDownload && params.reason
        ? [{
            type: "section",
            text: { type: "mrkdwn", text: `*상세:*\n${params.reason}` },
          } as any]
        : []),
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: slackContext },
        ],
      },
    ],
  };

  const teamsMessage = {
    "@type": "MessageCard",
    summary: actionLabel,
    themeColor,
    title: `${icon} ${actionLabel}`,
    sections: [{ facts: teamsFacts }]
  };

  const genericPayload = {
    event: eventType,
    action,
    result,
    userEmail: params.userEmail || "",
    ipAddress: params.ipAddress || "",
    timestamp: new Date().toISOString(),
  };

  await sendNotification(eventType, slackMessage, teamsMessage, genericPayload);
}
