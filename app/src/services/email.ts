/**
 * Email Service
 *
 * maintainer_name: Lee Sangha
 * maintainer_email: saanghaa@gmail.com
 * roles: DevOps Engineer, Site Reliability Engineer, Cloud Solutions Architect
 *
 * nodemailer를 사용한 실제 이메일 전송 서비스
 * 프로바이더별 SMTP 프리셋을 지원합니다.
 */

import nodemailer from "nodemailer";

export type EmailProvider = "gmail" | "naver" | "daum" | "kakao" | "custom";

export interface SmtpPreset {
  host: string;
  port: number;
  secure: boolean;
}

export const SMTP_PRESETS: Record<Exclude<EmailProvider, "custom">, SmtpPreset> = {
  gmail: { host: "smtp.gmail.com", port: 587, secure: false },
  naver: { host: "smtp.naver.com", port: 587, secure: false },
  daum:  { host: "smtp.daum.net",  port: 465, secure: true  },
  kakao: { host: "smtp.kakao.com", port: 465, secure: true  },
};

export interface EmailConfig {
  provider?: EmailProvider;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  fromEmail?: string;
  fromName?: string;
}

function resolveSmtp(config: EmailConfig): { host: string; port: number; secure: boolean } {
  const provider = config.provider ?? "custom";
  if (provider !== "custom" && SMTP_PRESETS[provider]) {
    return SMTP_PRESETS[provider];
  }
  const port = config.smtpPort ?? 587;
  return { host: config.smtpHost ?? "", port, secure: port === 465 };
}

function createTransporter(config: EmailConfig) {
  const { host, port, secure } = resolveSmtp(config);
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword,
    },
  });
}

/**
 * 임시 비밀번호 이메일 전송
 */
export async function sendPasswordResetEmail(
  toEmail: string,
  tempPassword: string,
  expiryDate: Date,
  config?: EmailConfig
): Promise<void> {
  const emailContent = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Proxmox Horizon - 임시 비밀번호 발급 안내
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

안녕하세요, ${toEmail}님

비밀번호 재설정 요청에 따라 임시 비밀번호가 발급되었습니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  임시 비밀번호: ${tempPassword}

  만료 시각: ${expiryDate.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

중요 안내사항:

1. 위 임시 비밀번호로 로그인하실 수 있습니다.
2. OTP는 그대로 유지되므로 기존에 등록한 OTP를 사용하세요.
3. 로그인 후 반드시 새로운 비밀번호로 변경해야 합니다.
4. 임시 비밀번호는 24시간 후 자동으로 만료됩니다.
5. 본인이 요청하지 않은 경우, 즉시 관리자에게 문의하세요.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

감사합니다.
Proxmox Horizon

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `;

  if (!config || !isEmailConfigured(config)) {
    console.log("\n[EMAIL - 콘솔 출력 모드]\n" + emailContent);
    return;
  }

  const transporter = createTransporter(config);
  await transporter.sendMail({
    from: `"${config.fromName || 'Proxmox Horizon'}" <${config.fromEmail || config.smtpUser}>`,
    to: toEmail,
    subject: 'Proxmox Horizon - 임시 비밀번호 발급 안내',
    text: emailContent,
  });
}

/**
 * 알림 이메일 전송
 */
export async function sendNotificationEmail(
  config: EmailConfig & { to: string[] },
  subject: string,
  body: string
): Promise<void> {
  if (!isEmailConfigured(config)) {
    console.log(`[EMAIL] 알림 전송 (콘솔): ${subject}\n${body}`);
    return;
  }

  const transporter = createTransporter(config);
  await transporter.sendMail({
    from: `"${config.fromName || 'Proxmox Horizon'}" <${config.fromEmail || config.smtpUser}>`,
    to: config.to.join(", "),
    subject,
    text: body,
  });
}

/**
 * 테스트 이메일 전송
 */
export async function sendTestEmail(
  config: EmailConfig & { to: string[] }
): Promise<void> {
  const transporter = createTransporter(config);
  const { host, port } = resolveSmtp(config);
  const providerLabel = config.provider && config.provider !== "custom"
    ? config.provider.toUpperCase()
    : `${host}:${port}`;

  await transporter.sendMail({
    from: `"Proxmox Horizon" <${config.fromEmail || config.smtpUser}>`,
    to: config.to.join(", "),
    subject: "Proxmox Horizon - 이메일 테스트",
    text: `이메일 알림 설정이 정상적으로 동작합니다.\n\nProvider: ${providerLabel}\nSMTP: ${host}:${port}`,
  });
}

/**
 * SMTP 설정 완료 여부 확인
 */
export function isEmailConfigured(config: EmailConfig): boolean {
  const provider = config.provider ?? "custom";
  const hasHost = provider !== "custom" || !!config.smtpHost;
  return !!(hasHost && config.smtpUser && config.smtpPassword);
}
