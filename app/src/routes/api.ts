import { Router } from "express";
import bcrypt from "bcryptjs";
import { downloadApi } from "./api/download";
import { vmsApi } from "./api/vms";
import { adminApi } from "./api/admin";
import { deployApi } from "./api/deploy";
import { vmRequestsApi } from "./api/vmRequests";
import { vmControlApi } from "./api/vmControl";
import { prisma } from "../services/prisma";
import { requireLogin } from "./middlewares/requireLogin";
import { isValidTemplate, getTemplateOptions, resolveTemplate, DEFAULT_TEMPLATE } from "../utils/themeTemplates";

export const apiRoutes = Router();

/**
 * [POST] /api/setup - 최초 관리자 계정 생성 (관리자가 없을 때만 허용)
 */
apiRoutes.post("/setup", async (req, res) => {
  try {
    // Verify no admin exists yet
    const adminCount = await prisma.user.count({ where: { isAdmin: true } });
    if (adminCount > 0) {
      return res.status(403).json({ error: "SETUP_ALREADY_DONE", message: "관리자 계정이 이미 존재합니다." });
    }

    const { email, password, confirmPassword } = req.body;

    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "INVALID_EMAIL", message: "이메일을 입력해주세요." });
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "INVALID_PASSWORD", message: "비밀번호는 최소 8자 이상이어야 합니다." });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "PASSWORD_MISMATCH", message: "비밀번호가 일치하지 않습니다." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const adminUser = await prisma.user.create({
      data: {
        email: email.trim().toLowerCase(),
        passwordHash,
        passwordLastChanged: new Date(),
        totpEnabled: false,
        isAdmin: true,
        mustChangePassword: false,
      },
    });

    // Upsert ADMIN group and add the new user as admin role
    const adminGroup = await prisma.group.upsert({
      where: { name: "ADMIN" },
      update: {},
      create: { name: "ADMIN" },
    });

    await prisma.groupMembership.upsert({
      where: { userId_groupId: { userId: adminUser.id, groupId: adminGroup.id } },
      update: { role: "admin" },
      create: { userId: adminUser.id, groupId: adminGroup.id, role: "admin" },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[API /setup] Error:", err);
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "계정 생성 중 오류가 발생했습니다." });
  }
});

/**
 * API 라우트 구성
 * 각 도메인별로 하위 라우터를 연결합니다.
 */

// 1. 보안 다운로드 API (Challenge 발급 및 OTP 재인증 다운로드)
apiRoutes.use("/download", downloadApi);

// 2. VM API (CSV export + legacy route deprecation handlers)
apiRoutes.use("/vms", vmsApi);

// 3. 관리자 API (사용자/그룹/감사로그 관리)
apiRoutes.use("/admin", adminApi);

// 4. VM 배포 API (Proxmox 토큰 기반)
apiRoutes.use("/deploy", deployApi);

// 5. VM 생성 요청 API (일반 사용자용)
apiRoutes.use("/vm-requests", vmRequestsApi);

// 6. VM 전원 관리 API (시작/중지/재부팅/삭제)
apiRoutes.use("/vms", vmControlApi);

// 7. 사용자 개인 테마 API (사용자별 저장)
apiRoutes.get("/theme-template", requireLogin, async (req, res) => {
  try {
    const userThemeKey = `theme_template_user_${req.user!.id}`;
    const userCfg = await prisma.systemConfig.findUnique({ where: { key: userThemeKey } });

    const hasUserTheme = Boolean(userCfg?.value);
    const template = hasUserTheme ? resolveTemplate(userCfg?.value) : DEFAULT_TEMPLATE;
    const source: "user" | "default" = hasUserTheme ? "user" : "default";

    res.json({ ok: true, template, source, options: getTemplateOptions() });
  } catch (e) {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

apiRoutes.patch("/theme-template", requireLogin, async (req, res) => {
  try {
    const { template } = req.body;
    if (!template || !isValidTemplate(template)) {
      return res.status(400).json({ error: "INVALID_TEMPLATE" });
    }

    const userThemeKey = `theme_template_user_${req.user!.id}`;
    await prisma.systemConfig.upsert({
      where: { key: userThemeKey },
      update: { value: template, updatedAt: new Date() },
      create: {
        id: `sc-theme-user-${req.user!.id}-${Date.now()}`,
        key: userThemeKey,
        value: template,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // 로그인 전 화면(로그인/OTP)에서도 마지막 테마를 보여주기 위해 쿠키 저장
    res.cookie("last_theme_template", template, {
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      httpOnly: true,
      sameSite: "lax"
    });

    res.json({ ok: true, template, source: "user", options: getTemplateOptions() });
  } catch (e) {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// 8. 언어 전환 API
apiRoutes.post("/language", (req, res) => {
  const { lang } = req.body;

  if (!lang || !['ko', 'en'].includes(lang)) {
    return res.status(400).json({ error: 'Invalid language. Use "ko" or "en".' });
  }

  // 쿠키에 선호 언어 저장 (1년 유효)
  res.cookie('preferred_lang', lang, {
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    httpOnly: true,
    sameSite: 'lax'
  });

  res.json({ ok: true, lang });
});

/**
 * 404 처리 (API 전용)
 * 정의되지 않은 API 경로로 접근 시 JSON 형태로 응답합니다.
 */
apiRoutes.use((req, res) => {
  res.status(404).json({
    error: "API_ENDPOINT_NOT_FOUND",
    path: req.originalUrl
  });
});

/**
 * API 전용 에러 핸들러 (Express 5.0 가이드)
 * 각 라우터에서 throw된 에러를 여기서 일괄 처리하여 일관된 JSON 응답을 보장합니다.
 */
apiRoutes.use((err: any, req: any, res: any, next: any) => {
  console.error(`[API Error] ${req.method} ${req.path}:`, err);
  
  const status = err.status || 500;
  res.status(status).json({
    error: err.name || "Internal Server Error",
    message: err.message || "An unexpected error occurred",
    result: "FAIL"
  });
});
