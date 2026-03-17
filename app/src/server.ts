/**
 * maintainer_name: Lee Sangha
 * maintainer_email: saanghaa@gmail.com
 * roles: DevOps Engineer, Site Reliability Engineer, Cloud Solutions Architect
 */

import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import session from "express-session";
import RedisStore from "connect-redis";
import Redis from "ioredis";
import rateLimit from "express-rate-limit";
import path from "path";

import { config } from "./config";
import { prisma } from "./services/prisma";
import { attachUser } from "./auth/attachUser";
import { loadMenus } from "./middlewares/loadMenus";

// 라우터 Import
import { authRoutes } from "./routes/auth";
import { apiRoutes } from "./routes/api";
import { uiRoutes } from "./routes/ui";
import { startVmSyncService, stopVmSyncService } from "./services/vmSyncService";
import { startAutoRotateScheduler, stopAutoRotateScheduler } from "./services/autoRotate";
import { startBackupScheduler, stopBackupScheduler } from "./services/backupScheduler";

const app = express();

/**
 * 1. 프록시 신뢰 설정 (Nginx 연동 필수)
 * express-rate-limit의 'X-Forwarded-For' 경고를 해결합니다.
 */
app.set("trust proxy", 1);

/**
 * 2. 보안 및 기본 미들웨어 설정
 */
app.use(helmet({
  contentSecurityPolicy: false, // EJS 인라인 스크립트 허용
}));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * 3. 뷰 엔진 및 정적 파일 설정
 * path.resolve를 사용하여 dist 환경에서도 views 폴더를 정확히 참조합니다.
 */
app.set("view engine", "ejs");
const viewsPath = path.resolve(__dirname, "views");
app.set("views", viewsPath);
app.use(express.static(path.resolve(__dirname, "public")));

console.log(`[Proxmox] Views Path: ${viewsPath}`);

/**
 * 4. Redis 및 세션 설정
 */
const redisClient = new Redis(config.redisUrl);
const redisStore = new RedisStore({
  client: redisClient,
  prefix: "km_sess:",
});

const DEFAULT_SESSION_MAX_HOURS = 12;
const DEFAULT_SESSION_IDLE_MINUTES = 30;
const sessionPolicyRuntime = {
  maxHours: DEFAULT_SESSION_MAX_HOURS,
  idleMinutes: DEFAULT_SESSION_IDLE_MINUTES,
  loadedAt: 0
};

async function refreshSessionPolicyRuntime(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - sessionPolicyRuntime.loadedAt < 60_000) return;

  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: "session_policy" } });
    if (row?.value) {
      const parsed = JSON.parse(row.value || "{}");
      const maxHours = Number(parsed.maxHours);
      const idleMinutes = Number(parsed.idleMinutes);
      sessionPolicyRuntime.maxHours =
        Number.isFinite(maxHours) && maxHours >= 1 && maxHours <= 24
          ? maxHours
          : DEFAULT_SESSION_MAX_HOURS;
      sessionPolicyRuntime.idleMinutes =
        Number.isFinite(idleMinutes) && idleMinutes >= 5 && idleMinutes <= 240
          ? idleMinutes
          : DEFAULT_SESSION_IDLE_MINUTES;
    } else {
      sessionPolicyRuntime.maxHours = DEFAULT_SESSION_MAX_HOURS;
      sessionPolicyRuntime.idleMinutes = DEFAULT_SESSION_IDLE_MINUTES;
    }
  } catch (err) {
    // Keep last loaded values on transient DB failures.
  } finally {
    sessionPolicyRuntime.loadedAt = now;
  }
}

const secureCookieEnv = String(process.env.SESSION_COOKIE_SECURE || "").toLowerCase();
const secureCookieMode: boolean | "auto" =
  secureCookieEnv === "true"
    ? true
    : secureCookieEnv === "false"
      ? false
      : "auto";

app.use(session({
  name: "km.sid",
  secret: config.sessionSecret,
  proxy: true,
  resave: false,
  saveUninitialized: false,
  store: redisStore,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookieMode,
    maxAge: 1000 * 60 * 60 * DEFAULT_SESSION_MAX_HOURS
  }
}));

app.use(async (req, res, next) => {
  try {
    await refreshSessionPolicyRuntime();
    const sess = req.session as any;
    if (!sess) return next();

    const now = Date.now();
    const idleMs = sessionPolicyRuntime.idleMinutes * 60 * 1000;
    const lastActivityAt = Number(sess.lastActivityAt || 0);

    if (lastActivityAt > 0 && now - lastActivityAt > idleMs) {
      const isApiRequest =
        req.originalUrl.startsWith("/api/") ||
        req.baseUrl === "/api" ||
        req.xhr;

      return req.session.destroy(() => {
        if (isApiRequest) {
          return res.status(401).json({
            error: "SESSION_IDLE_TIMEOUT",
            message: "Session expired due to inactivity"
          });
        }
        return res.redirect("/auth/login?expired=idle");
      });
    }

    sess.lastActivityAt = now;
    if (req.session.cookie) {
      req.session.cookie.maxAge = sessionPolicyRuntime.maxHours * 60 * 60 * 1000;
    }
    return next();
  } catch (err) {
    return next();
  }
});

// Basic CSRF hardening: block cross-site state-changing requests by Origin/Referer.
app.use((req, res, next) => {
  const method = req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  // Auth form posts can be blocked by strict proxy/header mismatches.
  // Protect state-changing app APIs first, and exclude auth flow here.
  if (req.originalUrl.startsWith("/auth/")) return next();

  const normalizeHost = (value: string) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");

  const allowedHosts = new Set<string>();
  const host = req.get("host");
  if (host) allowedHosts.add(normalizeHost(host));

  const forwardedHost = req.get("x-forwarded-host");
  if (forwardedHost) {
    forwardedHost.split(",").forEach((h) => {
      const n = normalizeHost(h);
      if (n) allowedHosts.add(n);
    });
  }

  if (req.hostname) allowedHosts.add(normalizeHost(req.hostname));
  if (config.baseUrl) {
    try {
      allowedHosts.add(normalizeHost(new URL(config.baseUrl).hostname));
    } catch {
      // ignore invalid BASE_URL
    }
  }

  const isSameHost = (value: string) => {
    try {
      const h = normalizeHost(new URL(value).hostname);
      return !!h && allowedHosts.has(h);
    } catch {
      return false;
    }
  };

  const origin = req.get("origin");
  if (origin && !isSameHost(origin)) {
    return res.status(403).json({ error: "FORBIDDEN", message: "Cross-site request blocked" });
  }

  const referer = req.get("referer");
  if (!origin && referer && !isSameHost(referer)) {
    return res.status(403).json({ error: "FORBIDDEN", message: "Cross-site request blocked" });
  }

  next();
});

/**
 * 5. 커스텀 미들웨어 및 서비스 연동
 */
app.use(attachUser(prisma));
app.use(loadMenus); // 동적 메뉴 로드

/**
 * 5-1. First-run setup guard
 * Redirects to /setup when no admin account exists yet.
 * Caches the "setup done" state in memory to avoid a DB query on every request.
 */
let setupComplete = false;

app.use(async (req, res, next) => {
  // Fast path: setup already done, skip guard entirely.
  if (setupComplete) return next();

  // Allow the setup page and its API, plus vendor assets, to pass through.
  const path = req.path;
  if (
    path === "/setup" ||
    path.startsWith("/api/setup") ||
    path.startsWith("/vendor")
  ) {
    return next();
  }

  try {
    const adminCount = await prisma.user.count({ where: { isAdmin: true } });
    if (adminCount > 0) {
      setupComplete = true; // cache: no need to check again
      return next();
    }
    // No admin exists — redirect every request to the setup page.
    return res.redirect("/setup");
  } catch (err) {
    // On DB error, let the request proceed normally (fail-open).
    return next();
  }
});

/**
 * 6. Rate Limit (DDoS 방어)
 */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later."
});
app.use(limiter);

/**
 * 7. 라우팅 설정
 */
app.use("/auth", authRoutes); // 로그인/OTP 관련
app.use("/", uiRoutes);       // 대시보드 관련
app.use("/api", apiRoutes);    // API 관련

/**
 * 8. 서버 기동
 */
const server = app.listen(config.port, () => {
  const base = config.baseUrl ? `${config.baseUrl}:${config.port}` : `0.0.0.0:${config.port}`;
  console.log(`[Proxmox] Server is running on ${base}`);
  // VM 상태 동기화 서비스 시작
  startVmSyncService();
  startAutoRotateScheduler();
  startBackupScheduler();
});

/**
 * 9. Graceful Shutdown
 */
const shutdown = async (signal: string) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  stopVmSyncService();
  stopAutoRotateScheduler();
  stopBackupScheduler();
  server.close(async () => {
    try {
      await prisma.$disconnect();
      await redisClient.quit();
      process.exit(0);
    } catch (err) {
      process.exit(1);
    }
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

refreshSessionPolicyRuntime(true).catch(() => {
  // no-op (defaults stay active)
});
