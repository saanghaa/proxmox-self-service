import { Router } from "express";
import { prisma } from "../../services/prisma";
import Redis from "ioredis";
import { config } from "../../config";
import { requireLogin } from "../middlewares/requireLogin";
import { decryptText } from "../../services/crypto";
import { verifyTotp } from "../../services/totp";
import { writeAudit } from "../../services/audit";
import { v4 as uuidv4 } from "uuid";
import { getClientIp } from "../../utils/requestIp";

// Redis 인스턴스 (메모리 효율을 위해 싱글톤 권장되나 로직 흐름 유지)
const redis = new Redis(config.redisUrl);
export const downloadApi = Router();
const NO_AUTO_ROTATE_UNTIL = new Date("2099-12-31T00:00:00.000Z");

/**
 * 1단계: 다운로드 준비 (/api/download/prepare)
 * OTP 입력을 위한 1회성 챌린지 ID를 생성하고 Redis에 60초간 보관합니다.
 */
downloadApi.post("/prepare", requireLogin, async (req, res) => {
  const { fingerprint, hostname } = req.body || {};
  if (!fingerprint) return res.status(400).json({ error: "MISSING_FINGERPRINT" });

  // 1회성 고유 ID 생성
  const challengeId = uuidv4();
  const redisKey = `ch:${challengeId}`;

  // 사용자의 의도와 타겟 키를 Redis에 바인딩 (TTL: 60초)
  await redis.set(redisKey, JSON.stringify({
    userId: req.user!.id,
    action: "KEY_DOWNLOAD",
    fingerprint,
    hostname: hostname || 'vm'
  }), "EX", 60);

  return res.json({
    challenge_id: challengeId,
    ttl_sec: 60,
    message: "Challenge created. Please verify OTP within 60 seconds."
  });
});

/**
 * 2단계: 최종 다운로드 (/api/download/key)
 * OTP 검증 및 챌린지 일치 확인 후, 암호화된 키를 복호화하여 전송합니다.
 */
downloadApi.post("/key", requireLogin, async (req, res) => {
  const { fingerprint, challenge_id, hostname, otp } = req.body || {};
  const ip = getClientIp(req);
  const ua = req.get("user-agent") || "";

  // 1. 파라미터 유효성 검사
  if (!fingerprint || !challenge_id || !otp) {
    return res.status(400).json({ error: "MISSING_REQUIRED_FIELDS" });
  }

  // 2. Redis 챌린지 검증
  const redisKey = `ch:${challenge_id}`;
  const rawChallenge = await redis.get(redisKey);
  
  if (!rawChallenge) {
    await writeAudit({
      userId: req.user!.id, action: "KEY_DOWNLOAD", result: "FAIL",
      reason: "CHALLENGE_EXPIRED", fingerprint, requestIp: ip, userAgent: ua
    });
    return res.status(410).json({ error: "CHALLENGE_EXPIRED" }); // 410 Gone
  }

  const ch = JSON.parse(rawChallenge);

  // 세션 사용자 정보와 챌린지 생성 정보가 일치하는지 확인 (세션 하이재킹 방어)
  if (ch.userId !== req.user!.id || ch.fingerprint !== fingerprint) {
    await writeAudit({
      userId: req.user!.id, action: "KEY_DOWNLOAD", result: "FAIL",
      reason: "CHALLENGE_MISMATCH", fingerprint, requestIp: ip, userAgent: ua
    });
    return res.status(403).json({ error: "FORBIDDEN_ACCESS" });
  }

  // 3. OTP 실시간 재검증
  const isOtpValid = verifyTotp(req.user!, otp);
  if (!isOtpValid) {
    await writeAudit({
      userId: req.user!.id, action: "KEY_DOWNLOAD", result: "FAIL",
      reason: "OTP_INVALID", fingerprint, requestIp: ip, userAgent: ua
    });
    return res.status(401).json({ error: "INVALID_OTP" });
  }

  // 4. DB에서 키 조회
  const keyRow = await prisma.key.findUnique({ where: { fingerprint } });
  if (!keyRow) {
    return res.status(404).json({ error: "KEY_NOT_FOUND" });
  }

  // 5. 1회성 챌린지 즉시 소진 (중복 다운로드 방지)
  await redis.del(redisKey);

  // 6. 복호화 및 파일 전송
  try {
    const privateKeyPlain = decryptText(keyRow.privateKeyEnc);

    // hostname이 있으면 사용, 없으면 챌린지에서 가져오기, 그것도 없으면 기본값
    const vmHostname = hostname || ch.hostname || 'vm';
    const filename = `${vmHostname}_${keyRow.keyVersion}.pem`;

    await writeAudit({
      userId: req.user!.id, action: "KEY_DOWNLOAD", result: "SUCCESS",
      fingerprint, keyVersion: keyRow.keyVersion, requestIp: ip, userAgent: ua,
      vmHostname
    });

    // 수동 다운로드 이후에는 자동 교체 대상에서 제외
    // (해당 fingerprint를 사용하는 Linux VM 전체)
    await prisma.vm.updateMany({
      where: {
        deletedAt: null,
        osType: { not: "windows" },
        job: { keyFingerprint: fingerprint }
      },
      data: { lastRotatedAt: NO_AUTO_ROTATE_UNTIL }
    });

    res.setHeader("Content-Type", "application/x-pem-file");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

    return res.send(privateKeyPlain);

  } catch (err: any) {
    console.error("[Download Error] Decryption failed:", err);
    return res.status(500).json({ error: "KEY_DECRYPTION_FAILED" });
  }
});
