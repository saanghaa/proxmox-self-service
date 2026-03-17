# Proxmox Horizon 아키텍처 정의서

이 문서는 Proxmox Horizon의 현재 코드베이스를 기준으로 시스템 구조, 운영 경계, 보안 모델, 그리고 설계 철학을 정의합니다.

문서 범위:
- 웹 애플리케이션: `app/src`
- 데이터 계층: PostgreSQL, Prisma, Redis
- Reverse Proxy: `servers/nginx`
- Proxmox VE 연동 및 VM 배포 엔진
- 인증, OTP, 감사로그, 알림, 상태 동기화

문서 비범위:
- SSO / OIDC
- 멀티테넌시 조직 분리
- Kubernetes 기반 분산 배포

## 1. 시스템 개요

Proxmox Horizon은 Proxmox VE 기반 가상머신 운영을 위해 만든 Self-Service 포털입니다.

핵심 역할:
- 일반 사용자
  - VM 생성 요청
  - 본인 권한 범위 내 VM 조회 및 기본 제어
  - SSH 키 다운로드 및 교체
- 관리자
  - 사용자, 그룹, 쿼터, 정책 관리
  - Proxmox 노드 및 토큰 등록
  - VM 요청 승인, 반려, 배포, 운영 관제

핵심 목표:
- 사용자는 인프라 내부 구현을 몰라도 필요한 VM을 요청할 수 있어야 한다.
- 관리자는 배포와 운영을 자동화하되 통제권을 잃지 않아야 한다.
- 운영 환경이 완벽하지 않아도 실제 현장에서 굴러가야 한다.

## 2. 설계 철학

### 2.1 Self-Service First

사용자는 Proxmox CLI나 하이퍼바이저 상세 구조를 몰라도 업무를 수행할 수 있어야 합니다.  
VM 요청, 조회, 제어, 키 다운로드는 웹 UI 중심으로 제공하며, 관리자는 승인과 정책만 관리하는 구조를 지향합니다.

### 2.2 Admin Control Without Micromanagement

자동화는 관리자의 통제권을 대체하기 위한 것이 아니라 반복 작업을 줄이기 위한 수단입니다.  
승인, 반려, 재배포, 토큰 확인, 정책 변경, 알림 설정 같은 결정 지점은 관리자에게 남기고, 반복 API 호출과 상태 수집은 시스템이 맡습니다.

### 2.3 Secure By Default, Friction Only Where It Matters

로그인 이후에도 OTP 게이트를 두고, 민감 작업은 다시 OTP 재인증을 요구합니다.  
반면 일반 조회나 일상적 UI 이동까지 불필요하게 복잡하게 만들지는 않습니다.

적용 예:
- 로그인 후 OTP 검증 전까지 보호 경로 진입 차단
- 토큰 보기, 키 다운로드, 키 교체 같은 민감 작업은 추가 OTP 요구
- 감사로그를 통해 누가 무엇을 했는지 추적 가능

### 2.4 Explicit Over Implicit

운영 자동화는 하되, 무엇이 자동으로 결정되는지는 예측 가능해야 합니다.  
예를 들어 Proxmox 노드 자동 등록도 “클러스터를 읽어 오되 관리망 기준으로 등록한다”처럼 명시적인 규칙을 둡니다.

적용 예:
- Proxmox 노드 등록 시 입력한 기준 노드를 기반으로 같은 클러스터를 탐색
- 비로컬 노드는 gateway가 있는 관리 인터페이스를 우선 사용
- 자동 매칭 실패 시 관리자가 수동 선택 가능

### 2.5 Operate In Imperfect Infrastructure

현실의 운영 환경은 인증서, 네트워크 대역, Cloud Image 준비 상태가 항상 이상적이지 않습니다.  
Proxmox Horizon은 이런 불완전성을 전제로 “운영 가능한 기본값”을 제공합니다.

적용 예:
- 자체서명 인증서 환경을 고려한 TLS 완화 설정
- BASE_URL에 과도하게 의존하지 않는 접근 전략
- 동기화 실패 시 전체 상태를 오염시키지 않는 보수적 갱신

### 2.6 Auditability Over Hidden Magic

자동화가 많을수록 기록은 더 중요합니다.  
승인, 배포, 삭제, 로그인 실패, 키 다운로드, 토큰 보기 같은 이벤트는 감사로그와 알림 체계에서 확인 가능해야 합니다.

### 2.7 Incremental Customization

UI 텍스트, 메뉴, 섹션 라벨, 테마는 코드 변경 없이도 점진적으로 바꿀 수 있어야 합니다.  
그래서 `SystemConfig`와 JSON defaults를 조합하는 구조를 사용합니다.

## 3. 런타임 토폴로지

기본 배포는 Docker Compose 단일 호스트입니다.

구성 요소:
- `nginx`
  - 외부 HTTP/HTTPS 진입점
  - 정적/리버스 프록시 처리
- `app`
  - Express + EJS 기반 웹 애플리케이션
  - Proxmox API 호출, 정책 적용, 배포 오케스트레이션 수행
- `postgres`
  - 사용자, VM, 요청, 정책, 감사로그 저장
- `redis`
  - 세션 저장소

논리 구조:

```text
Client Browser
    |
    v
[ Nginx ]
    |
    v
[ App / Express ]
   |        \
   |         \--> [ Redis ]
   |
   +------------> [ PostgreSQL ]
   |
   +------------> [ Proxmox VE API ]
```

## 4. 애플리케이션 구조

### 4.1 서버 엔트리포인트

- `app/src/server.ts`
  - `helmet`, `cookie-parser`, `express-session`, `connect-redis`
  - `trust proxy` 활성화
  - UI 라우트, 인증 라우트, API 라우트 연결
  - 스케줄러와 동기화 서비스 시작/종료 관리

### 4.2 라우팅 계층

- UI 라우트: `app/src/routes/ui.ts`
  - `/`
  - `/admin`
- 인증 라우트: `app/src/routes/auth.ts`
  - `/auth/login`
  - `/auth/change-password`
  - `/auth/otp`
  - `/auth/otp-setup`
  - `/auth/otp-recovery`
- API 라우트: `app/src/routes/api.ts`
  - `/api/admin/*`
  - `/api/deploy/*`
  - `/api/vm-requests/*`
  - `/api/vms/*`
  - `/api/download/*`

### 4.3 미들웨어와 접근 제어

- `app/src/auth/attachUser.ts`
  - 세션에서 사용자 로드
  - 비밀번호 변경 강제, OTP 강제 흐름 처리
- `app/src/routes/middlewares/requireLogin.ts`
  - 로그인 및 OTP 검증 완료 여부 확인
- `app/src/routes/middlewares/requireAdmin.ts`
  - 관리자 권한 확인
- `app/src/middlewares/loadMenus.ts`
  - 언어, 메뉴, 레이블, 테마 로드

## 5. 데이터 모델

주요 모델:
- `User`
- `OtpRecoveryCode`
- `Group`
- `GroupMembership`
- `GroupQuota`
- `VmRequest`
- `DeployTask`
- `Vm`
- `VmDisk`
- `Key`
- `AuditLog`
- `PveNode`
- `SystemConfig`
- `DeployTemplate`

설계 의도:
- 사용자 권한과 운영 정책을 분리해 관리한다.
- 배포 요청과 실제 VM 엔티티를 분리해 승인 흐름과 실행 흐름을 나눈다.
- `SystemConfig`로 운영 중 커스터마이징 가능한 설정을 DB에 저장한다.

민감정보 저장 정책:
- Proxmox Token Secret: 암호화 저장
- SSH Private Key: 암호화 저장
- OTP 복구코드: 해시 저장

## 6. Proxmox 연동 철학과 구조

### 6.1 토큰 기반 연동

Proxmox VE는 사용자 비밀번호 대신 API Token 기반으로 연결합니다.

관련 코드:
- `app/src/services/proxmox.ts`
- `app/src/routes/api/deploy.ts`

의도:
- 계정 비밀번호를 앱에 저장하지 않는다.
- 권한 범위를 분리하고 회전 가능한 자격증명을 사용한다.

### 6.2 클러스터 등록 전략

Proxmox Horizon은 기준 노드 하나를 입력받아 같은 클러스터의 다른 노드까지 자동 등록할 수 있습니다.

현재 원칙:
- 처음 연결한 로컬 노드는 사용자가 입력한 관리 주소를 기준으로 사용
- 비로컬 노드는 클러스터/네트워크 조회 결과 중 gateway가 있는 관리 인터페이스를 우선 사용
- corosync 전용 대역을 관리 주소로 자동 채택하지 않음
- 자동 판별 실패 시 관리자가 수정 가능

이 원칙은 “자동화는 하되 운영자가 예상 가능한 방식이어야 한다”는 철학을 반영합니다.

### 6.3 Cloud Image와 Snippet 분리

배포 성공률과 운영 일관성을 위해 다음을 분리합니다.

- Cloud Image: 관리자가 준비하고 선택
- Cloud-init snippet: Proxmox 호스트에 사전 배치

이 구조의 목적:
- 앱이 외부 이미지 다운로드까지 과도하게 책임지지 않도록 함
- 운영자가 검증한 이미지와 스니펫만 사용하도록 유도
- 문제 발생 시 책임 경계를 명확히 함

## 7. 배포 엔진

배포의 중심은 `DeployTask`입니다.

관련 코드:
- `app/src/services/deployEngine.ts`

배포 흐름:
1. 요청 검토 및 승인
2. 배포 노드, 이미지, 네트워크 값 결정
3. SSH 키 생성 및 저장
4. VM 생성
5. Cloud-init 설정 반영
6. DB 레코드 및 감사로그 기록

배포 엔진 원칙:
- 실패는 기록하고, 가능한 경우 정리(cleanup)한다.
- 중복 IP와 hostname은 사전에 최대한 방지한다.
- 부분 성공과 전체 실패를 구분해 운영자가 정확히 판단할 수 있게 한다.

## 8. 상태 동기화와 운영 일관성

관련 코드:
- `app/src/services/vmSyncService.ts`

원칙:
- DB는 Proxmox의 캐시이자 운영용 조회 모델이다.
- 하지만 최종 원천은 Proxmox이므로 주기적으로 상태를 재동기화한다.
- 일부 노드 조회 실패가 전체 상태를 망치지 않도록 보수적으로 갱신한다.

동기화 대상:
- VM 상태
- 노드 정보
- 디스크 슬롯
- 노드 변경 사항

## 9. 인증과 보안 모델

### 9.1 세션 + OTP 이중 게이트

인증은 다음 순서를 따릅니다.

1. 이메일/비밀번호 검증
2. 비밀번호 변경 필요 여부 확인
3. OTP 등록 또는 OTP 검증
4. 보호 경로 접근 허용

### 9.2 민감 작업 재인증

다음과 같은 작업은 추가 OTP 재인증을 요구합니다.
- Proxmox Token Secret 보기
- SSH 키 다운로드
- SSH 키 교체

이유:
- 세션 탈취나 공용 PC 환경에서 민감 데이터 노출을 줄이기 위함

### 9.3 감사로그 우선

보안 기능은 차단만으로 끝나지 않습니다.  
시스템은 “누가 무엇을 시도했고 결과가 어땠는지”를 기록해야 합니다.

관련 코드:
- `app/src/services/audit.ts`

## 10. 설정과 커스터마이징

관련 코드:
- `app/src/middlewares/loadMenus.ts`
- `app/src/utils/labelLoader.ts`
- `app/src/utils/uiStringLoader.ts`

커스터마이징 대상:
- 메뉴 구성
- 섹션 라벨
- UI 텍스트
- 비밀번호 정책
- 테마 템플릿
- 알림 채널 설정

설계 의도:
- 운영자가 코드 수정 없이도 UI와 정책 일부를 조정할 수 있어야 한다.
- 하지만 완전한 런타임 자유도보다는 안전한 제한형 커스터마이징을 우선한다.

## 11. 관측성과 운영

로그와 운영 포인트:
- 앱 로그: 컨테이너 로그 기준
- 감사로그: DB 저장
- 알림: Slack / Teams / Custom Webhook
- 통계: 관리자 대시보드

원칙:
- 운영자는 장애를 “추측”이 아니라 “기록”으로 판단할 수 있어야 한다.
- 사용자 화면은 단순해야 하지만, 관리자 화면은 원인 파악에 필요한 단서를 제공해야 한다.

## 12. 문서 관계

함께 읽으면 좋은 문서:
- [사용자 매뉴얼](./USER_MANUAL.md)
- [관리자 매뉴얼](./ADMIN_MANUAL.md)
- [설치 매뉴얼](./INSTALLATION_MANUAL.md)
- [백업 매뉴얼](./BACKUP_MANUAL.md)

## 13. 결론

Proxmox Horizon의 아키텍처는 “현실적인 운영 환경에서 실제로 굴러가는 Self-Service 포털”을 목표로 합니다.

핵심은 다음 세 가지입니다.
- 사용자는 단순하게
- 관리자는 통제 가능하게
- 시스템은 기록 가능하게
