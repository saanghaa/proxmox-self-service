# Install And Deploy Flow

## 개요

이 문서는 `install.sh`와 `deploy.sh`가 실제로 어떤 순서로 동작하는지 코드 기준으로 정리한 운영 흐름 문서입니다.

- 최초 설치: `install.sh`
- 운영 배포: `deploy.sh`
- 앱 초기화: `app/docker-entrypoint.sh`
- 서버 실행: `app/src/server.ts`

---

## 1. 최초 설치 흐름: `install.sh`

### 실행 예시

```bash
bash install.sh
```

```bash
bash install.sh --init
```

```bash
bash install.sh --init --user admin@example.com --passwd 'Example123!'
```

주의:

- `bash install.sh` 만 실행하면 사용법만 출력하고 종료합니다.
- 실수로 무인 설치가 시작되는 상황을 막기 위한 동작입니다.
- `install.sh` 는 `--init` 기반 초기화 설치 전용입니다.
- 첫 관리자 계정은 설치 후 브라우저 `/setup` 에서 만들거나, `--user` / `--passwd` 로 자동 생성할 수 있습니다.

### 지원 옵션

| 옵션 | 의미 | 현재 동작 |
|---|---|---|
| `--init` | 초기화 설치 | 기존 데이터 삭제 후 재설치 |
| `--user EMAIL` | 초기 관리자 이메일 지정 | `--init` 과 함께 사용 시 자동 생성 |
| `--passwd PASS` | 초기 관리자 비밀번호 지정 | `--init` 과 함께 사용 시 자동 생성 |

현재 동작:

- 인자 없이 `bash install.sh` 실행 시에도 사용법만 출력하고 종료
- 실제 설치는 `bash install.sh --init` 으로만 시작

### 설치 순서도

```text
[관리자]
  |
  | bash install.sh [옵션]
  v
[install.sh]
  |
  |-- 1. 인자 파싱
  |     - --init
  |     - --user
  |     - --passwd
  |
  |-- 2. 기본 검사
  |     - docker-compose.yml 존재 확인
  |     - sudo 존재 확인
  |
  |-- 3. Docker / Docker Compose 확인
  |     - 없으면 apt 기반으로 설치
  |     - docker group 등록 시도
  |
  |-- 4. 소스 preflight 검사
  |     - 오래된 템플릿/라우트 조합 검사
  |     - CDN 참조 검사
  |     - admin.ejs TDZ 위험 검사
  |
  |-- 5. 영속 디렉터리 생성
  |     - servers/app/logs
  |     - servers/app/uploads
  |     - servers/postgres/data
  |     - servers/postgres/backups
  |     - servers/redis/data
  |     - servers/nginx/certs
  |     - servers/nginx/logs
  |     - servers/backups
  |
  |-- 6. --init 인 경우
  |     - YES 확인
  |     - .env + servers 스냅샷 백업
  |     - docker compose down -v
  |     - DB/Redis/uploads/logs 삭제
  |     - .env 삭제
  |
  |-- 7. .env 처리
  |     - 있으면 유지
  |     - 없으면 자동 생성
  |       * POSTGRES_PASSWORD
  |       * DATABASE_URL
  |       * REDIS_URL
  |       * SESSION_SECRET
  |       * KEY_ENCRYPTION_SECRET
  |
  |-- 8. 선택 사항: 첫 관리자 자동 생성 준비
  |     - --user / --passwd 가 있으면
  |       INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD 전달
  |     - 없으면 웹 /setup 사용
  |
  |-- 9. 컨테이너 기동
  |     - docker compose up -d --build
  |
  |-- 10. Postgres health 확인
  |
  v
[설치 완료 메시지 출력]
```

### `--init` 옵션 상세

`bash install.sh --init` 은 아래 데이터를 제거하고 다시 설치합니다.

- `./servers/postgres/data`
- `./servers/redis/data`
- `./servers/app/uploads`
- `./servers/app/logs`
- `./.env`

주의:

- `KEY_ENCRYPTION_SECRET` 도 새로 생성되므로, 기존 DB에 저장된 암호화 데이터와의 호환성이 끊길 수 있습니다.
- 기존 운영 데이터를 유지해야 한다면 `--init` 을 사용하면 안 됩니다.

### 첫 관리자 생성 방법

방법 1. 웹에서 생성

```bash
bash install.sh --init
```

- 설치 후 브라우저로 접속
- 관리자 계정이 없으면 `/setup` 으로 이동
- 웹 화면에서 첫 관리자 이메일/비밀번호 생성

방법 2. CLI 옵션으로 자동 생성

```bash
bash install.sh --init --user admin@example.com --passwd 'Example123!'
```

- 설치 중 첫 관리자 계정을 자동 생성
- 이미 관리자가 있으면 추가 생성하지 않음
- 이 경우 첫 접속 시 `/setup` 대신 바로 로그인 흐름 사용

---

## 2. 컨테이너 구성 흐름: `docker-compose.yml`

설치 스크립트가 실제로 띄우는 컨테이너는 아래 4개입니다.

```text
postgres  -> DB
redis     -> 세션/캐시
app       -> Node.js/Express 애플리케이션
nginx     -> 외부 80/443 진입점
```

### 컨테이너 관계

```text
[브라우저]
  |
  v
[nginx]
  |
  v
[app]
  | \
  |  \
  v   v
[postgres] [redis]
```

### 영속 데이터 위치

| 용도 | 경로 |
|---|---|
| PostgreSQL 데이터 | `./servers/postgres/data` |
| PostgreSQL 백업 | `./servers/postgres/backups` |
| Redis 데이터 | `./servers/redis/data` |
| 앱 로그 | `./servers/app/logs` |
| 업로드 파일 | `./servers/app/uploads` |
| 앱 백업 파일 | `./servers/backups` |
| Nginx 로그 | `./servers/nginx/logs` |
| 인증서 | `./servers/nginx/certs` |

---

## 3. 앱 초기화 흐름: `app/docker-entrypoint.sh`

`app` 컨테이너가 시작되면 `node dist/server.js` 전에 entrypoint가 먼저 실행됩니다.

### 순서도

```text
[app 컨테이너 시작]
  |
  v
[docker-entrypoint.sh]
  |
  |-- 1. prisma migrate deploy
  |-- 2. 필요 시 prisma db push
  |-- 3. user 수 확인
  |     - 0명이면 prisma/seed.ts 실행
  |
  |-- 4. bootstrap admin 확인
  |     - 관리자 없고 INITIAL_ADMIN_EMAIL/PASSWORD 있으면 자동 생성
  |     - 없으면 웹 /setup 유지
  |
  |-- 5. menu_config 확인
  |     - 없으면 기본 JSON 적재
  |     - 있으면 필요 시 기본 메뉴 병합
  |
  |-- 6. section_labels 확인
  |     - 없으면 기본 JSON 적재
  |
  v
exec node dist/server.js
```

### 기본 설정 파일 우선순위

entrypoint 는 아래 우선순위로 기본 JSON 파일을 찾습니다.

1. `/config/<파일명>` 단, `USE_CONFIG_DEFAULTS=true` 인 경우 우선
2. `/app/dist/defaults/<파일명>`
3. `/config/<파일명>` fallback

즉 현재 구조에서는 보통 이미지 안의 `dist/defaults` 가 기본값으로 쓰이고, 필요하면 `./config` 마운트 파일을 fallback 으로 사용합니다.

---

## 4. 앱 런타임 흐름: `app/src/server.ts`

서버가 시작되면 Express 앱이 아래 순서로 동작합니다.

### 순서도

```text
node dist/server.js
  |
  v
[Express 초기화]
  |
  |-- helmet, cookie-parser, body parser
  |-- views 경로 설정
  |-- public 정적 파일 제공
  |-- Redis 세션 연결
  |-- 세션 만료 정책 로드
  |-- 기본 CSRF 방어
  |-- attachUser
  |-- loadMenus
  |
  |-- 최초 실행 가드
  |     관리자 계정이 없으면 /setup 으로 리다이렉트
  |
  |-- 라우터 등록
  |     /auth
  |     /
  |     /api
  |
  |-- 백그라운드 서비스 시작
  |     VM sync
  |     auto rotate
  |     backup scheduler
  |
  v
[서비스 제공 시작]
```

### 첫 접속 시 동작

```text
관리자 계정 없음
  -> 모든 요청 /setup 으로 이동
  -> 최초 관리자 계정 생성
  -> 이후 일반 로그인 흐름 사용
```

### 이후 일반 사용자 흐름

```text
/auth/login
  -> 로그인
  -> 세션 생성
  -> 대시보드(/) 또는 관리자 페이지(/admin)
  -> API 호출은 /api 아래에서 처리
```

---

## 5. 운영 배포 흐름: `deploy.sh`

### 실행 예시

```bash
bash deploy.sh
```

```bash
DEPLOY_NO_CACHE=1 bash deploy.sh
```

### 동작 방식

`deploy.sh` 는 최초 설치용이 아니라, 이미 설치된 환경에서 코드 변경 사항을 반영할 때 사용합니다.

### 지원 방식

| 방식 | 의미 |
|---|---|
| `bash deploy.sh` | 일반 롤링 배포 |
| `DEPLOY_NO_CACHE=1 bash deploy.sh` | 캐시 없이 앱 이미지를 다시 빌드 |

### 배포 순서도

```text
[관리자]
  |
  | bash deploy.sh
  v
[deploy.sh]
  |
  |-- 0. .env 검증
  |     - .env 없으면 실패
  |     - DATABASE_URL 확인
  |     - 비밀번호에 @ 가 있으면 URL 인코딩 자동 보정 시도
  |
  |-- 1. 컨테이너 빌드 및 교체
  |     - 기본: docker compose up -d --build --remove-orphans
  |     - DEPLOY_NO_CACHE=1:
  |       docker compose build --no-cache app
  |       docker compose up -d --remove-orphans
  |
  |-- 2. DB 스키마 보조 동기화
  |     - docker compose exec app npx prisma db push ...
  |     - 실패해도 배포는 계속 진행
  |
  |-- 3. dangling image 정리
  |     - docker image prune -f
  |
  v
[배포 완료]
```

### `install.sh` 와 `deploy.sh` 차이

| 항목 | `install.sh` | `deploy.sh` |
|---|---|---|
| 목적 | 최초 설치 / 재초기화 | 운영 중 코드 반영 |
| Docker 미설치 대응 | 설치 시도 | 설치 안 함 |
| `.env` 자동 생성 | 예 | 아니오 |
| `--init` 지원 | 예 | 아니오 |
| 데이터 삭제 가능성 | 있음 (`--init`) | 없음 |
| 앱 재빌드 | 예 | 예 |
| DB 동기화 | entrypoint 포함 | entrypoint + 보조 db push |

---

## 6. 추천 운영 절차

### 최초 설치

```bash
bash install.sh --help
```

```bash
bash install.sh --init
```

현재 기준으로는 `bash install.sh` 단독 실행 시 설치가 시작되지 않고, 사용법만 출력됩니다.

과거 방식 예시:

```bash
bash install.sh --user admin@example.com --passwd 'Example123!'
```

이 명령 형태는 입력은 가능하지만 현재 스크립트에서는 계정 생성에 사용되지 않습니다.
실제 첫 관리자 계정은 설치 후 웹 브라우저에서 `/setup` 으로 접속해 생성합니다.

이후:

1. 브라우저 접속
2. `/setup` 에서 첫 관리자 생성
3. 로그인 후 운영 시작

### 코드 변경 반영

```bash
bash deploy.sh
```

### 캐시 없이 강제 재빌드

```bash
DEPLOY_NO_CACHE=1 bash deploy.sh
```

### 정말 처음부터 다시 설치해야 할 때만

```bash
bash install.sh --init
```

---

## 7. 관련 파일

- [`install.sh`](/mnt/e/auto_deploy/proxmox-self-service/install.sh)
- [`deploy.sh`](/mnt/e/auto_deploy/proxmox-self-service/deploy.sh)
- [`docker-compose.yml`](/mnt/e/auto_deploy/proxmox-self-service/docker-compose.yml)
- [`app/docker-entrypoint.sh`](/mnt/e/auto_deploy/proxmox-self-service/app/docker-entrypoint.sh)
- [`app/src/server.ts`](/mnt/e/auto_deploy/proxmox-self-service/app/src/server.ts)
- [`app/src/routes/ui.ts`](/mnt/e/auto_deploy/proxmox-self-service/app/src/routes/ui.ts)
