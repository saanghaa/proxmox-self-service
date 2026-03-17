import { Request, Response, NextFunction } from "express";

/**
 * 관리자 권한(isAdmin=true)을 요구하는 미들웨어입니다.
 * 반드시 requireLogin 미들웨어 뒤에 사용해야 합니다.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !(req.user as any).isAdmin) {
    // Note: when mounted under /api, req.path is stripped (e.g. "/admin/users")
    // so use originalUrl/baseUrl instead of req.path.
    const isApiRequest =
      req.originalUrl.startsWith("/api/") ||
      req.baseUrl === "/api" ||
      req.xhr;

    if (isApiRequest) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "Administrator privileges required"
      });
    }

    return res.redirect("/");
  }

  next();
}
