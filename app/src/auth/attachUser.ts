import { PrismaClient, User } from "@prisma/client";
import { Request, Response, NextFunction } from "express";

// 1. 세션 데이터 타입 정의 (auth.ts와 동일하게 otpVerified 사용)
declare module "express-session" {
  interface SessionData {
    userId?: string;
    otpVerified?: boolean; 
  }
}

// 2. Express Request 객체 확장
declare global {
  namespace Express {
    interface Request {
      user?: User | null;
    }
  }
}

export function attachUser(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = req.session as any;
    const uid = session?.userId;
    const path = req.path;

    // 세션에 userId가 없으면 다음으로 (로그인 안 된 상태)
    if (!uid) {
      return next();
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: uid },
      });

      if (user) {
        // 비활성화된 사용자의 세션 차단
        if (!user.isActive) {
          session.userId = undefined;
          return next();
        }

        req.user = user;

        /**
         * [핵심 로직 1] 비밀번호 변경 강제
         * mustChangePassword가 true이면 비밀번호 변경 페이지로 강제 이동
         */
        if (user.mustChangePassword) {
          if (!path.startsWith("/auth/change-password") && !path.startsWith("/auth/logout")) {
            return res.redirect("/auth/change-password");
          }
        }

        /**
         * [핵심 로직 2] OTP 검증 체크
         * OTP가 활성화된 유저인데, 세션에 otpVerified 마크가 없고,
         * 현재 경로가 OTP 관련 페이지가 아니라면 OTP 입력 페이지로 강제 이동
         */
        if (user.totpEnabled && !session.otpVerified) {
          if (!path.startsWith("/auth/otp") && !path.startsWith("/auth/logout") && !path.startsWith("/auth/change-password")) {
            return res.redirect("/auth/otp");
          }
        }
      } else {
        session.userId = undefined;
      }
    } catch (error) {
      console.error("[Auth Middleware Error] Failed to fetch user:", error);
    }

    next();
  };
}
