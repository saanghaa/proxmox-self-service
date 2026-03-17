import { Request, Response, NextFunction } from "express";

// 세션 데이터 타입 확장
declare module "express-session" {
  interface SessionData {
    otpVerified?: boolean;
  }
}

/**
 * 로그인 및 2차 인증(OTP) 통과 여부를 검증하는 미들웨어입니다.
 */
export function requireLogin(req: Request, res: Response, next: NextFunction) {
  // 1. 유저 정보(req.user)가 없거나 OTP 인증(otpVerified)을 통과하지 못한 경우
  // attachUser 미들웨어가 req.user를 채워주므로, 여기서 두 가지를 모두 체크합니다.
  // req.session이 없는 경우도 고려하여 체크합니다.
  if (!req.user || !req.session || !req.session.otpVerified) {

    // API 요청(JSON 응답)인지 브라우저 페이지 요청(Redirect)인지 구분
    // Note: when mounted at /api, req.path is stripped (e.g. "/admin/users"),
    // so we must rely on originalUrl/baseUrl instead of req.path.
    const isApiRequest =
      req.originalUrl.startsWith("/api/") ||
      req.baseUrl === "/api" ||
      req.xhr;

    if (isApiRequest) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Login and OTP verification required"
      });
    } else {
      // 일반 UI 페이지 접근 시 로그인 페이지로 리다이렉트
      return res.redirect(`/auth/login?returnUrl=${encodeURIComponent(req.originalUrl)}`);
    }
  }

  // 2. 검증 통과 시 다음 로직으로 진행
  next();
}
