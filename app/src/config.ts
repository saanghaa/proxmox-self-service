import dotenv from "dotenv";
import path from "path";

// .env 파일 로드 (로컬 개발 환경용)
dotenv.config({ path: path.join(__dirname, "../../.env") });

/**
 * 환경 변수 유효성 검사
 * 필수 변수가 누락된 경우 서버 실행을 즉시 중단하여 런타임 에러를 방지합니다.
 */
const requiredEnv = [
  "REDIS_URL",
  "SESSION_SECRET",
  "KEY_ENCRYPTION_SECRET",
  "DATABASE_URL"
];

requiredEnv.forEach((envName) => {
  if (!process.env[envName]) {
    console.error(`[Config Error] Missing environment variable: ${envName}`);
    process.exit(1); // 시스템 종료
  }
});

export const config = {
  // 서버 포트 및 베이스 URL
  port: Number(process.env.PORT || 3000),
  // BASE_URL is optional. If unset, the app should behave domain-agnostically behind reverse proxies.
  // (Avoid hardcoding localhost, which breaks external deployments.)
  baseUrl: process.env.BASE_URL || "",

  // 인프라 연결 정보 (Redis / DB)
  redisUrl: process.env.REDIS_URL as string,
  databaseUrl: process.env.DATABASE_URL as string,

  // 보안 및 세션
  sessionSecret: process.env.SESSION_SECRET as string,

  /**
   * 키 암호화용 시크릿 (AES-256-GCM)
   * 보안을 위해 반드시 32바이트 이상의 강력한 문자열을 권장합니다.
   */
  keyEncSecret: process.env.KEY_ENCRYPTION_SECRET as string,

  /**
   * Slack 웹훅 URL (알림용)
   * 설정하지 않으면 알림이 전송되지 않습니다.
   */
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || ""
};
