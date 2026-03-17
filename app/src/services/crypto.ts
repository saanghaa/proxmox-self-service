import crypto from "crypto";
import { config } from "../config";

/**
 * 32바이트(256비트) 암호화 키 생성
 * config.keyEncSecret을 해싱하여 일정한 길이의 키를 보장합니다.
 */
const ENCRYPTION_KEY = crypto.createHash("sha256").update(config.keyEncSecret).digest();

/**
 * 텍스트 암호화 (AES-256-GCM)
 * @param plain 암호화할 평문 문자열
 * @returns IV + TAG + CipherText가 결합된 base64 문자열
 */
export function encryptText(plain: string): string {
  // GCM 모드에서 권장되는 IV 길이는 12바이트입니다.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);

  const enc = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag(); // 16바이트 인증 태그

  // 복호화에 필요한 IV와 TAG를 암호문과 함께 묶어서 반환
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * 텍스트 복호화 (AES-256-GCM)
 * @param payloadB64 암호화된 base64 문자열
 * @returns 복호화된 평문 문자열
 * @throws 변조되거나 키가 맞지 않을 경우 에러 발생
 */
export function decryptText(payloadB64: string): string {
  try {
    const buf = Buffer.from(payloadB64, "base64");

    // 데이터 구조 분해: IV(12) | TAG(16) | CipherText(나머지)
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);

    const plain = Buffer.concat([
      decipher.update(enc),
      decipher.final()
    ]);

    return plain.toString("utf8");
  } catch (error: any) {
    // 복호화 실패 시 (키 불일치 또는 데이터 변조)
    console.error("❌ [Crypto] Decryption failed:", error.message);
    throw new Error("Invalid encryption key or corrupted data");
  }
}
