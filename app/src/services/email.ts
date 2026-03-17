/**
 * Email Service
 *
 * 임시 비밀번호 등 이메일 전송을 담당하는 서비스
 * 현재는 콘솔 로그로 출력하며, 실제 SMTP 설정 시 nodemailer 등을 사용할 수 있습니다.
 */

export interface EmailConfig {
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  fromEmail?: string;
  fromName?: string;
}

/**
 * 임시 비밀번호 이메일 전송
 *
 * @param toEmail 수신자 이메일 주소
 * @param tempPassword 임시 비밀번호
 * @param expiryDate 만료 일시
 */
export async function sendPasswordResetEmail(
  toEmail: string,
  tempPassword: string,
  expiryDate: Date
): Promise<void> {
  // TODO: 실제 SMTP 서버를 통한 이메일 전송 구현
  // 현재는 콘솔 로그로 출력합니다.

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

  console.log("\n" + emailContent);

  // 실제 이메일 전송 예시 (nodemailer 사용 시):
  /*
  import nodemailer from 'nodemailer';

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Proxmox Horizon'}" <${process.env.SMTP_FROM_EMAIL}>`,
    to: toEmail,
    subject: 'Proxmox Horizon - 임시 비밀번호 발급 안내',
    text: emailContent,
    html: `<pre>${emailContent}</pre>`,
  });
  */
}

/**
 * 이메일 설정 검증
 *
 * @returns SMTP 설정이 완료되었는지 여부
 */
export function isEmailConfigured(): boolean {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASSWORD
  );
}

/**
 * 이메일 전송 테스트
 *
 * @param toEmail 테스트 수신자 이메일
 */
export async function sendTestEmail(toEmail: string): Promise<void> {
  console.log(`\n[EMAIL TEST] 테스트 이메일 전송 대상: ${toEmail}`);
  console.log(`[EMAIL TEST] SMTP 설정 상태: ${isEmailConfigured() ? '완료' : '미완료 (콘솔 출력 모드)'}\n`);

  if (!isEmailConfigured()) {
    console.warn('⚠️  SMTP 설정이 완료되지 않았습니다. .env 파일에 다음 항목을 추가하세요:');
    console.warn('   SMTP_HOST=smtp.gmail.com');
    console.warn('   SMTP_PORT=587');
    console.warn('   SMTP_USER=your-email@gmail.com');
    console.warn('   SMTP_PASSWORD=your-app-password');
    console.warn('   SMTP_FROM_EMAIL=noreply@yourdomain.com');
    console.warn('   SMTP_FROM_NAME=Proxmox Horizon\n');
  }
}
