import { authenticator } from "@otplib/v12-adapter";
import { User } from "@prisma/client";

/**
 * 사용자의 TOTP 토큰을 검증합니다.
 * auth.ts와 동일하게 otplib을 사용하여 라이브러리 통일.
 * @param user Prisma User 모델 (totpSecret, totpEnabled 필드 포함)
 * @param token 사용자가 입력한 6자리 숫자 문자열
 * @returns 검증 성공 여부
 */
export function verifyTotp(user: User, token: string): boolean {
  if (!user.totpEnabled || !user.totpSecret) {
    return false;
  }

  // window: 1 → 현재 시간 기준 전후 1개(±30초)의 토큰을 허용
  authenticator.options = { window: 1 };
  return authenticator.check(token, user.totpSecret);
}

/**
 * 새로운 OTP 설정을 위한 Secret 생성 (초기 등록 시 사용)
 */
export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}
