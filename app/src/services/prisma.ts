import { PrismaClient } from "@prisma/client";

/**
 * Prisma Client 인스턴스 생성
 * log 설정을 통해 쿼리 실행 시간이나 에러를 추적할 수 있습니다.
 */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" 
    ? ["query", "info", "warn", "error"] 
    : ["error", "warn"], // 운영 환경에서는 에러와 경고 위주로 로그 남김
});

/**
 * DB 연결 확인용 초기화 함수 (선택 사항)
 */
async function testDbConnection() {
  try {
    await prisma.$connect();
    console.log("🐘 [PostgreSQL] Connected successfully to DB");
  } catch (error) {
    console.error("❌ [PostgreSQL] Connection failed:", error);
    process.exit(1);
  }
}

// 개발 환경일 때만 기동 시 연결 테스트
if (process.env.NODE_ENV !== "production") {
  testDbConnection();
}
