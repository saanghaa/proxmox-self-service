import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { authenticator } from "@otplib/v12-adapter";
import qrcode from "qrcode";
import { prisma } from "../services/prisma";
import { writeAudit } from "../services/audit";
import { isPasswordExpired, getPasswordPolicy } from "../config/passwordPolicy";
import { sendPasswordResetEmail } from "../services/email";
import { getClientIp } from "../utils/requestIp";

export const authRoutes = Router();

// Recovery code policy:
// - Issue a single recovery code (admin-focused operational model)
// - UUID format for easy read/copy/paste (e.g. 3F2504E0-4F89-11D3-9A0C-0305E82C3301)
const OTP_RECOVERY_CODE_COUNT = 1;

function normalizeRecoveryCode(code: string): string {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "");
}

function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

function generateRecoveryCode(): string {
  return crypto.randomUUID().toUpperCase();
}

async function issueOtpRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: OTP_RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  await prisma.$transaction([
    prisma.otpRecoveryCode.deleteMany({ where: { userId } }),
    prisma.otpRecoveryCode.createMany({
      data: codes.map((code) => ({
        userId,
        codeHash: hashRecoveryCode(code)
      }))
    })
  ]);
  return codes;
}

function regenerateSession(req: any): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * 비밀번호 복잡도 검증 (DB 설정 기반)
 */
async function validatePasswordComplexity(password: string): Promise<{ valid: boolean; error?: string }> {
  const policy = await getPasswordPolicy();

  if (password.length < policy.minLength) {
    return { valid: false, error: `비밀번호는 최소 ${policy.minLength}자 이상이어야 합니다.` };
  }
  if (policy.complexity.requireUppercase && !/[A-Z]/.test(password)) {
    return { valid: false, error: "비밀번호에 대문자가 최소 1개 포함되어야 합니다." };
  }
  if (policy.complexity.requireLowercase && !/[a-z]/.test(password)) {
    return { valid: false, error: "비밀번호에 소문자가 최소 1개 포함되어야 합니다." };
  }
  if (policy.complexity.requireNumbers && !/[0-9]/.test(password)) {
    return { valid: false, error: "비밀번호에 숫자가 최소 1개 포함되어야 합니다." };
  }
  if (policy.complexity.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    return { valid: false, error: "비밀번호에 특수문자(!@#$%^&* 등)가 최소 1개 포함되어야 합니다." };
  }
  return { valid: true };
}

/**
 * 안전한 비밀번호 자동 생성 (12자)
 */
export function generateSecurePassword(): string {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const special = '!@#$%^&*';

  let password = '';
  // 각 카테고리에서 최소 1개씩 보장
  password += pickRandomChar(uppercase);
  password += pickRandomChar(lowercase);
  password += pickRandomChar(numbers);
  password += pickRandomChar(special);

  // 나머지 8자는 랜덤하게
  const allChars = uppercase + lowercase + numbers + special;
  for (let i = 0; i < 8; i++) {
    password += pickRandomChar(allChars);
  }

  // Fisher-Yates shuffle with crypto-grade randomness
  const chars = password.split('');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function pickRandomChar(charset: string): string {
  return charset[crypto.randomInt(0, charset.length)];
}

/**
 * [GET] /auth/login - 로그인 페이지 렌더링
 */
authRoutes.get("/login", (req, res) => {
  res.render("login", { error: null });
});

/**
 * [GET] /auth/register - 회원가입 페이지 렌더링
 */
authRoutes.get("/register", (req, res) => {
  res.render("register", { error: null, success: false });
});

/**
 * [POST] /auth/register - 회원가입 처리
 */
authRoutes.post("/register", async (req, res) => {
  const { email, password, confirmPassword } = req.body;

  // 유효성 검사
  if (!email || !password || !confirmPassword) {
    return res.render("register", { error: "모든 필드를 입력해주세요.", success: false });
  }

  // 비밀번호 복잡도 검증
  const complexityCheck = await validatePasswordComplexity(password);
  if (!complexityCheck.valid) {
    return res.render("register", { error: complexityCheck.error, success: false });
  }

  if (password !== confirmPassword) {
    return res.render("register", { error: "비밀번호가 일치하지 않습니다.", success: false });
  }

  try {
    // 이메일 중복 체크
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.render("register", { error: "이미 등록된 이메일입니다.", success: false });
    }

    // 비밀번호 해싱 및 계정 생성 (비활성화 상태)
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        email,
        passwordHash,
        passwordLastChanged: new Date(),
        isActive: false,  // 관리자 승인 필요
        isAdmin: false,
        totpEnabled: false,
        mustChangePassword: false
      }
    });

    // 성공 메시지 표시
    res.render("register", { error: null, success: true });
  } catch (error) {
    console.error("[REGISTER_ERROR]", error);
    res.render("register", { error: "회원가입 중 오류가 발생했습니다.", success: false });
  }
});

/**
 * [GET] /auth/forgot-password - 비밀번호 찾기 페이지
 */
authRoutes.get("/forgot-password", (req, res) => {
  res.render("forgot-password", { error: null, success: null });
});

/**
 * [POST] /auth/forgot-password - 임시 비밀번호 발급 및 이메일 전송
 */
authRoutes.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.render("forgot-password", {
      error: "이메일 주소를 입력해주세요.",
      success: null
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    // 보안: 사용자 존재 여부와 관계없이 동일한 응답 (이메일 열거 공격 방지)
    if (!user || !user.isActive) {
      return res.render("forgot-password", {
        error: null,
        success: "등록된 이메일 주소로 임시 비밀번호가 전송되었습니다. (전송까지 최대 5분 소요)"
      });
    }

    // 임시 비밀번호 생성 (12자, 복잡도 충족)
    const tempPassword = generateSecurePassword();
    const tempPasswordHash = await bcrypt.hash(tempPassword, 10);

    // 임시 비밀번호 만료 시간 설정 (24시간)
    const now = new Date();
    const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // 사용자 DB 업데이트
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: tempPasswordHash,
        tempPasswordSetAt: now,
        tempPasswordExpiry: expiry,
        mustChangePassword: true,
        passwordLastChanged: now
      }
    });

    // 이메일 전송 (SMTP 미설정 시 콘솔 로그로 출력)
    await sendPasswordResetEmail(email, tempPassword, expiry);

    // 감사 로그 기록
    await writeAudit({
      userId: user.id,
      action: "PASSWORD_RESET_REQUEST",
      result: "SUCCESS",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    res.render("forgot-password", {
      error: null,
      success: "등록된 이메일 주소로 임시 비밀번호가 전송되었습니다. (현재는 서버 로그에서 확인 가능)"
    });
  } catch (error) {
    console.error("[FORGOT_PASSWORD_ERROR]", error);
    res.render("forgot-password", {
      error: "임시 비밀번호 발급 중 오류가 발생했습니다.",
      success: null
    });
  }
});

/**
 * [POST] /auth/login - 아이디/비밀번호 검증 및 분기
 * 순서: 비밀번호 변경 → OTP 등록/검증 → 대시보드
 */
authRoutes.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (user && user.isActive && await bcrypt.compare(password, user.passwordHash)) {
      // 임시 비밀번호 만료 확인
      if (user.tempPasswordExpiry && new Date() > user.tempPasswordExpiry) {
        return res.render("login", {
          error: "임시 비밀번호가 만료되었습니다. 비밀번호 찾기를 다시 진행해주세요."
        });
      }

      // Session fixation 방지: 자격 증명 검증 후 세션 ID 재발급
      await regenerateSession(req);
      (req.session as any).userId = user.id;
      delete (req.session as any).otpVerified;
      delete (req.session as any).otpRecoveryCodes;
      delete (req.session as any).otpSetupId;

      return req.session.save(async () => {
        // 1. 비밀번호 변경 강제 확인 (임시 비밀번호 포함)
        if (user.mustChangePassword) {
          const isTempPassword = user.tempPasswordSetAt !== null;
          return res.redirect(`/auth/change-password?tempPassword=${isTempPassword}`);
        }

        // 2. 비밀번호 만료 확인
        if (await isPasswordExpired(user.passwordLastChanged)) {
          // 비밀번호 만료 시 변경 강제
          return res.redirect("/auth/change-password?expired=true");
        }

        // 3. OTP 설정 확인
        if (!user.totpEnabled) {
          return res.redirect("/auth/otp-setup");
        }

        // 4. OTP 인증
        res.redirect("/auth/otp");
      });
    }

    await writeAudit({
      userId: user?.id,
      action: "LOGIN_FAIL",
      result: "FAIL",
      reason: "Invalid email or password",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });
    res.render("login", { error: "이메일 또는 비밀번호가 올바르지 않습니다." });
  } catch (error) {
    console.error("[AUTH_ERROR]", error);
    await writeAudit({
      action: "LOGIN_FAIL",
      result: "FAIL",
      reason: "Login route internal error",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });
    res.status(500).render("login", { error: "서버 내부 에러가 발생했습니다." });
  }
});

/**
 * [GET] /auth/change-password - 비밀번호 변경 페이지
 */
authRoutes.get("/change-password", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.redirect("/auth/login");
  const isExpired = req.query.expired === 'true';
  const isTempPassword = req.query.tempPassword === 'true';
  const isVoluntary = req.query.voluntary === 'true';
  res.render("change-password", {
    error: null,
    success: null,
    expired: isExpired,
    tempPassword: isTempPassword,
    voluntary: isVoluntary
  });
});

/**
 * [POST] /auth/change-password - 비밀번호 변경 처리
 */
authRoutes.post("/change-password", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.redirect("/auth/login");

  const { currentPassword, newPassword, confirmPassword } = req.body;
  const isVoluntary = req.query.voluntary === 'true';

  // 에러 시 공통 렌더 옵션
  const renderError = (error: string, tempPw = false) => {
    res.render("change-password", {
      error,
      success: null,
      expired: false,
      tempPassword: tempPw,
      voluntary: isVoluntary
    });
  };

  // 입력값 검증
  if (!currentPassword || !newPassword || !confirmPassword) {
    return renderError("모든 필드를 입력해주세요.");
  }

  try {
    // 현재 사용자 조회
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.redirect("/auth/login");

    // 현재 비밀번호 확인
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      return renderError("현재 비밀번호가 올바르지 않습니다.", user.tempPasswordSetAt !== null);
    }

    // 새 비밀번호 복잡도 검증
    const complexityCheck = await validatePasswordComplexity(newPassword);
    if (!complexityCheck.valid) {
      return renderError(complexityCheck.error || "비밀번호 복잡도 불충분", user.tempPasswordSetAt !== null);
    }

    // 새 비밀번호 일치 확인
    if (newPassword !== confirmPassword) {
      return renderError("새 비밀번호가 일치하지 않습니다.", user.tempPasswordSetAt !== null);
    }

    // 이전 비밀번호와 동일한지 확인
    const isSameAsOld = await bcrypt.compare(newPassword, user.passwordHash);
    if (isSameAsOld) {
      return renderError("새 비밀번호는 현재 비밀번호와 달라야 합니다.", user.tempPasswordSetAt !== null);
    }

    // 비밀번호 업데이트
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordLastChanged: new Date(),
        mustChangePassword: false,
        // 임시 비밀번호 관련 필드 초기화
        tempPasswordSetAt: null,
        tempPasswordExpiry: null
      }
    });

    // 감사 로그 기록
    await writeAudit({
      userId: user.id,
      action: "PASSWORD_CHANGED",
      result: "SUCCESS",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    // 자발적 변경: 대시보드로 즉시 리다이렉트 (성공 알림 포함)
    if (isVoluntary) {
      return res.redirect("/?pwChanged=true");
    }

    // 강제 변경: 다음 단계로 이동
    const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!updatedUser) return res.redirect("/auth/login");

    if (!updatedUser.totpEnabled) {
      return res.redirect("/auth/otp-setup");
    }
    res.redirect("/auth/otp");
  } catch (error) {
    console.error("[CHANGE_PW_ERROR]", error);
    renderError("비밀번호 변경 중 에러가 발생했습니다.");
  }
});

/**
 * [GET] /auth/otp-setup - 첫 로그인 사용자용 OTP 등록 (QR 코드 생성)
 */
authRoutes.get("/otp-setup", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.redirect("/auth/login");

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.totpEnabled) return res.redirect("/");

    const err = String((req.query as any)?.error || "");
    const errorMsg =
      err === "invalid"
        ? "OTP 번호가 올바르지 않습니다."
        : err === "server"
          ? "OTP 설정 처리 중 오류가 발생했습니다. 다시 시도해주세요."
          : null;

    // OTP 설정 세션 ID를 확인하여 중복 생성 방지
    const sessionOtpSetupId = (req.session as any).otpSetupId;
    let secret = user.totpSecret;

    // 세션에 저장된 설정 ID와 현재 사용자 ID가 다르거나, secret이 없는 경우에만 새로 생성
    if (!secret || sessionOtpSetupId !== userId) {
      secret = authenticator.generateSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: { totpSecret: secret }
      });
      // 세션에 OTP 설정 ID 저장 (페이지 새로고침 시 재생성 방지)
      (req.session as any).otpSetupId = userId;
    }

    const otpauth = authenticator.keyuri(user.email, "Proxmox-Horizon", secret);
    let qrCodeUrl: string | null = null;
    try {
      qrCodeUrl = await qrcode.toDataURL(otpauth);
    } catch (e) {
      // Fallback: QR generation failure should not block OTP enrollment.
      console.error("[OTP_SETUP_QR_ERROR]", e);
      qrCodeUrl = null;
    }
    res.render("otp-setup", { qrCodeUrl, secret, error: errorMsg });
  } catch (error) {
    // Avoid opaque 500s; also prevents upstream "prematurely closed connection" when errors occur.
    console.error("[OTP_SETUP_ERROR]", error);
    res.status(500).send("OTP 설정 중 에러 발생");
  }
});

/**
 * [POST] /auth/otp-setup - QR 코드 스캔 후 첫 검증 및 활성화
 */
authRoutes.post("/otp-setup", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).send("Unauthorized");

  try {
    const token = String((req.body as any)?.token || "").trim();
    // Basic validation: 6 digits
    if (!/^[0-9]{6}$/.test(token)) {
      return res.redirect("/auth/otp-setup?error=invalid");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret) {
      return res.redirect("/auth/otp-setup?error=invalid");
    }

    const isValid = authenticator.verify({ token, secret: user.totpSecret });
    if (!isValid) {
      return res.redirect("/auth/otp-setup?error=invalid");
    }

    const recoveryCodes = await issueOtpRecoveryCodes(user.id);
    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true }
    });
    await writeAudit({
      userId: user.id,
      action: "OTP_SETUP_COMPLETED",
      result: "SUCCESS",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });
    // OTP 완료 시 세션 재발급
    await regenerateSession(req);
    (req.session as any).userId = user.id;
    (req.session as any).otpVerified = true;
    (req.session as any).otpRecoveryCodes = recoveryCodes;
    return req.session.save(() => res.redirect("/auth/otp-recovery-codes"));
  } catch (error) {
    console.error("[OTP_SETUP_POST_ERROR]", error);
    // Keep the user in the OTP setup flow instead of dropping a 500.
    return res.redirect("/auth/otp-setup?error=server");
  }
});

/**
 * [GET] /auth/otp-recovery-codes - OTP 복구코드 1회 표시
 */
authRoutes.get("/otp-recovery-codes", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.redirect("/auth/login");

  const codes = (req.session as any).otpRecoveryCodes as string[] | undefined;
  if (!codes || codes.length === 0) return res.redirect("/");

  res.render("otp-recovery-codes", { codes });
});

/**
 * [POST] /auth/otp-recovery-codes/ack - 복구코드 확인 완료 처리
 */
authRoutes.post("/otp-recovery-codes/ack", (req, res) => {
  delete (req.session as any).otpRecoveryCodes;
  req.session.save(() => res.redirect("/"));
});

/**
 * [GET] /auth/otp - 등록 완료된 사용자의 OTP 입력 화면 렌더링
 */
authRoutes.get("/otp", (req, res) => {
  if (!(req.session as any).userId) return res.redirect("/auth/login");
  res.render("otp", { error: null });
});

/**
 * [POST] /auth/otp - 기존 사용자의 2차 인증(OTP) 번호 검증
 */
authRoutes.post("/otp", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).send("Unauthorized");

  const { token } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (user && user.totpSecret) {
      const isValid = authenticator.verify({ token, secret: user.totpSecret });
      if (isValid) {
        await writeAudit({
          userId: user.id,
          action: "LOGIN_SUCCESS",
          result: "SUCCESS",
          requestIp: getClientIp(req),
          userAgent: req.get("user-agent") || ""
        });
        // OTP 검증 완료 시 세션 재발급
        await regenerateSession(req);
        (req.session as any).userId = user.id;
        (req.session as any).otpVerified = true;
        return req.session.save(() => {
          res.redirect("/");
        });
      }
    }
    await writeAudit({
      userId,
      action: "LOGIN_FAIL",
      result: "FAIL",
      reason: "Invalid OTP token",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });
    res.render("otp", { error: "OTP 번호가 일치하지 않습니다." });
  } catch (error) {
    console.error("[OTP_AUTH_ERROR]", error);
    await writeAudit({
      userId,
      action: "LOGIN_FAIL",
      result: "FAIL",
      reason: "OTP verification internal error",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });
    res.status(500).send("인증 처리 중 에러 발생");
  }
});

/**
 * [GET] /auth/otp-recovery - 복구코드 입력 페이지
 */
authRoutes.get("/otp-recovery", (req, res) => {
  if (!(req.session as any).userId) return res.redirect("/auth/login");
  res.render("otp-recovery", { error: null });
});

/**
 * [POST] /auth/otp-recovery - 복구코드 검증 후 OTP 재등록 진입
 */
authRoutes.post("/otp-recovery", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).send("Unauthorized");

  const rawCode = String(req.body?.code || "").trim().toUpperCase();
  if (!rawCode) {
    return res.render("otp-recovery", { error: "복구코드를 입력해주세요." });
  }

  try {
    const codeHash = hashRecoveryCode(rawCode);
    const code = await prisma.otpRecoveryCode.findFirst({
      where: { userId, codeHash, usedAt: null }
    });

    if (!code) {
      return res.render("otp-recovery", { error: "유효하지 않은 복구코드입니다." });
    }

    await prisma.$transaction([
      prisma.otpRecoveryCode.update({
        where: { id: code.id },
        data: { usedAt: new Date() }
      }),
      prisma.user.update({
        where: { id: userId },
        data: { totpEnabled: false, totpSecret: null }
      })
    ]);
    await writeAudit({
      userId,
      action: "OTP_RECOVERY_USED",
      result: "SUCCESS",
      reason: "Recovery code accepted; OTP reset for re-enrollment",
      requestIp: getClientIp(req),
      userAgent: req.get("user-agent") || ""
    });

    delete (req.session as any).otpVerified;
    delete (req.session as any).otpSetupId;
    req.session.save(() => res.redirect("/auth/otp-setup"));
  } catch (error) {
    console.error("[OTP_RECOVERY_ERROR]", error);
    res.render("otp-recovery", { error: "복구코드 처리 중 에러가 발생했습니다." });
  }
});

/**
 * [GET] /auth/generate-password - 안전한 비밀번호 자동 생성 API
 */
authRoutes.get("/generate-password", (req, res) => {
  const password = generateSecurePassword();
  res.json({ password });
});

/**
 * [GET] /auth/logout - 로그아웃
 */
authRoutes.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/auth/login");
  });
});
