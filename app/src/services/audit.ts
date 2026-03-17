import { prisma } from "./prisma";
import { notifyAuditEvent } from "./slack";

/**
 * 감사 로그 데이터 인터페이스
 */
export interface AuditLogInput {
  userId?: string;
  action: string;      // 예: KEY_DOWNLOAD, KEY_IMPORT, LOGIN, OTP_VERIFY
  result: string;      // SUCCESS, FAIL
  reason?: string;     // 실패 시 사유

  requestIp?: string;
  userAgent?: string;

  groupId?: string;
  jobId?: string;
  vmId?: string;
  keyVersion?: string;
  fingerprint?: string;

  // 알림 전용 (DB 저장 안 됨)
  vmHostname?: string;
  vmid?: number;
  groupName?: string;
  oldGroupName?: string;
  newGroupName?: string;
}

/**
 * 시스템 내의 모든 주요 액션을 AuditLog 테이블에 기록합니다.
 * SRE 팁: 로그 기록 실패가 메인 비즈니스 로직에 영향을 주지 않도록 설계합니다.
 */
export async function writeAudit(input: AuditLogInput) {
  try {
    // 1. Prisma를 사용하여 DB에 로그 삽입 (알림 전용 필드 제외)
    const { vmHostname, vmid, groupName, oldGroupName, newGroupName, ...dbData } = input;
    await prisma.auditLog.create({
      data: {
        ...dbData,
        userAgent: input.userAgent ? input.userAgent.substring(0, 500) : undefined
      }
    });

    // 2. 알림 전송 (실패해도 메인 로직 영향 없음)
    try {
      let userEmail: string | undefined;
      if (input.userId) {
        const user = await prisma.user.findUnique({
          where: { id: input.userId },
          select: { email: true }
        });
        userEmail = user?.email;
      }
      await notifyAuditEvent({
        action: input.action,
        result: input.result,
        reason: input.reason,
        userEmail,
        ipAddress: input.requestIp,
        userAgent: input.userAgent,
        keyVersion: input.keyVersion,
        fingerprint: input.fingerprint,
        vmHostname,
        vmid,
        groupName,
        oldGroupName,
        newGroupName,
      });
    } catch (notifyError) {
      console.error("Warning: Failed to send audit notification.", {
        error: notifyError,
        action: input.action
      });
    }
  } catch (error) {
    /**
     * 로그 기록 중 에러 발생 시 처리
     * SRE 관점: 로그 저장 실패 때문에 '키 다운로드' 같은 메인 서비스가 중단되면 안 됩니다.
     * 따라서 에러를 throw하지 않고 서버 로그(stdout)에만 남깁니다.
     */
    console.error("Critical: Failed to write AuditLog to database.", {
      error,
      originalData: input
    });
  }
}
