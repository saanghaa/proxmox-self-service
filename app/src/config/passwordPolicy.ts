import { prisma } from "../services/prisma";

/**
 * 기본 비밀번호 정책 (DB에 설정이 없을 때 사용)
 */
const DEFAULT_PASSWORD_POLICY = {
  expiryDays: 90,
  warningDays: 7,
  minLength: 8,
  complexity: {
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: true,
  },
};

/**
 * DB에서 비밀번호 정책 가져오기
 */
export async function getPasswordPolicy() {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: "password_policy" }
    });

    if (config) {
      return JSON.parse(config.value);
    }
  } catch (e) {
    console.error("[PasswordPolicy] Failed to load from DB:", e);
  }

  return DEFAULT_PASSWORD_POLICY;
}

/**
 * 하위 호환성을 위한 export (deprecated)
 * @deprecated Use getPasswordPolicy() instead
 */
export const PASSWORD_POLICY = DEFAULT_PASSWORD_POLICY;

/**
 * 비밀번호가 만료되었는지 확인
 */
export async function isPasswordExpired(passwordLastChanged: Date): Promise<boolean> {
  const policy = await getPasswordPolicy();

  if (policy.expiryDays === 0) {
    return false; // 만료 정책이 비활성화됨
  }

  const now = new Date();
  const daysSinceChange = Math.floor(
    (now.getTime() - passwordLastChanged.getTime()) / (1000 * 60 * 60 * 24)
  );

  return daysSinceChange >= policy.expiryDays;
}

/**
 * 비밀번호 만료 경고가 필요한지 확인
 */
export async function shouldWarnPasswordExpiry(passwordLastChanged: Date): Promise<{ warn: boolean; daysLeft: number }> {
  const policy = await getPasswordPolicy();

  if (policy.expiryDays === 0) {
    return { warn: false, daysLeft: 0 };
  }

  const now = new Date();
  const daysSinceChange = Math.floor(
    (now.getTime() - passwordLastChanged.getTime()) / (1000 * 60 * 60 * 24)
  );

  const daysLeft = policy.expiryDays - daysSinceChange;

  return {
    warn: daysLeft > 0 && daysLeft <= policy.warningDays,
    daysLeft: Math.max(0, daysLeft),
  };
}
