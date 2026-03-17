# Proxmox Horizon 백업 & 복구 매뉴얼

이 문서는 Proxmox Horizon의 **백업 생성 · 스케줄 · 다운로드 · 복구** 전 과정을 정리합니다.
웹 UI 기반 절차와 CLI 기반 절차를 모두 다룹니다.

---

## 문서 UI 레퍼런스 (Proxmox Theme)

본 매뉴얼의 화면 캡처/용어/UI 설명은 Proxmox 공식 사이트 테마를 기준으로 유지합니다.

- 톤앤매너: 다크 네이비 기반 + 퍼플 그라데이션 배경 + 민트 포인트 컬러
- 헤더 스타일: 상단 고정형 글로벌 내비게이션 + `Log-in` 아웃라인 버튼
- 주요 카드 스타일: 둥근 모서리 대형 미디어 카드 + 어두운 오버레이 텍스트
- 강조 컴포넌트: 민트색 CTA 버튼, 흰색 라운드 필터 버튼, 다크 배경 콘텐츠 카드
- 푸터 스타일: 블랙 푸터 바 + 회사 정보/정책 링크 + SNS 아이콘 라인

문서 내 UI 가이드 설명(버튼명, 위치, 동선)은 위 스타일과 실제 관리자 화면 구조를 우선 기준으로 작성합니다.

---

## 목차

1. [백업 시스템 개요](#1-백업-시스템-개요)
2. [복구 설계 철학 — 알림 보존 정책](#2-복구-설계-철학--알림-보존-정책)
3. [백업 파일 저장 위치](#3-백업-파일-저장-위치)
4. [백업 내용물](#4-백업-내용물)
5. [웹 UI — 백업 탭 진입](#5-웹-ui--백업-탭-진입)
6. [수동 백업 생성](#6-수동-백업-생성)
7. [자동 백업 스케줄 설정](#7-자동-백업-스케줄-설정)
8. [백업 목록 확인 및 다운로드](#8-백업-목록-확인-및-다운로드)
9. [복구 — 서버 백업에서 바로 복구](#9-복구--서버-백업에서-바로-복구)
10. [복구 — 외부 파일 업로드 복구](#10-복구--외부-파일-업로드-복구)
11. [복구 유형 비교: 설정 복구 vs 전체 DB 복구](#11-복구-유형-비교-설정-복구-vs-전체-db-복구)
12. [CLI 백업/복구 (scripts/)](#12-cli-백업복구-scripts) — backup-db.sh · restore-db.sh
13. [백업 파일 구조](#13-백업-파일-구조)
14. [주의사항 및 트러블슈팅](#14-주의사항-및-트러블슈팅)

---

## 1. 백업 시스템 개요

| 항목 | 내용 |
|------|------|
| **백업 대상** | PostgreSQL DB 전체 + SystemConfig JSON |
| **백업 형식** | `.tar.gz` 압축 아카이브 |
| **생성 방식** | 웹 UI 수동 / 자동 스케줄 / CLI 스크립트 |
| **복구 방식** | 웹 UI (설정 복구 / 전체 DB 복구) / CLI 스크립트 |
| **저장 위치** | 호스트 `./servers/backups/` ↔ 컨테이너 `/app/backups/` |

> **웹 UI 백업은 관리자(Admin) 계정으로만 접근 가능합니다.**

---

## 2. 복구 설계 철학 — 알림 보존 정책

### 배경: 복구가 알림을 침묵시킬 수 있다

설정 복구(`restoreConfig`)는 백업 시점의 `SystemConfig` 전체를 현재 DB에 덮어씁니다.
여기에는 Slack · Teams · Webhook 등 알림 채널 설정(`notification_config`)도 포함됩니다.

이때 다음 시나리오를 고려했습니다.

```
시나리오 A — 의도치 않은 알림 비활성화
  1. 운영 중 알림 ON 상태에서 백업 생성
  2. 이후 누군가 알림을 OFF로 변경
  3. 해당 백업으로 복구 → 알림이 다시 ON으로 복원 (정상)

시나리오 B — 백업 파일 조작
  1. 알림 ON 상태에서 백업 생성
  2. 악의적으로 백업 파일 내 notification_config의 enabled를 false로 수정
  3. 조작된 백업으로 복구 → 알림이 OFF가 되어 이후 이벤트를 감지 못함

시나리오 C — 신규 서버 마이그레이션
  1. 구 서버에서 알림 ON 상태로 백업
  2. 신규 서버에 복구 → 알림도 그대로 ON으로 복원 (정상)
```

### 결정: OR 병합 정책 (enabled = backup OR current)

세 시나리오를 모두 만족하는 방식으로, 복구 시 알림 채널의 `enabled` 값을
**백업 값과 현재 서버 값 중 하나라도 ON이면 ON으로 유지**하는 방식을 채택했습니다.

| 백업 enabled | 현재 서버 enabled | 복구 후 enabled | 설명 |
|:---:|:---:|:---:|------|
| ON | ON | **ON** | 정상 복구 |
| OFF (조작됨) | ON | **ON** | 현재 상태 보존 — 조작 무력화 |
| ON | OFF | **ON** | 백업 기준 복원 — 의도치 않은 비활성화 해소 |
| OFF | OFF | **OFF** | 양쪽 모두 의도적으로 비활성화 |

### 구현 위치

`app/src/utils/backup.ts` — `mergeNotificationEnabled()` 함수

```typescript
// 복구 전 현재 notification_config를 DB에서 읽음
const currentNotifRow = await prisma.systemConfig.findUnique(
  { where: { key: 'notification_config' } }
);

// notification_config 복구 시 enabled 병합
const value = (entry.key === 'notification_config' && currentNotifRow)
  ? mergeNotificationEnabled(entry.value, currentNotifRow.value)
  : entry.value;
```

### 감사 로그와의 관계

알림 수신 여부와 무관하게, 복구 실행 이벤트는 항상 **DB 감사 로그(`AuditLog`)에 기록**됩니다.
알림 채널이 완전히 비활성화된 상태에서도 감사 로그는 남으므로, 사후 추적이 가능합니다.

> **요약:** 복구는 알림을 켤 수는 있어도, 끌 수는 없다.

---

## 3. 백업 파일 저장 위치

```
proxmox/
└── servers/
    └── backups/                      ← 백업 아카이브 보관 위치
        ├── proxmox-backup-20260221_020000.tar.gz
        ├── proxmox-backup-20260222_020000.tar.gz
        └── ...
```

- Docker Compose에서 앱 컨테이너의 `/app/backups`로 마운트됩니다.
- 호스트에서 직접 접근하거나 SCP/rsync로 원격 보관이 가능합니다.

```bash
# 호스트에서 백업 파일 목록 확인
ls -lh ./servers/backups/

# 원격 서버로 복사 예시
scp ./servers/backups/proxmox-backup-20260221_020000.tar.gz user@backup-server:/backups/
```

---

## 4. 백업 내용물

백업 아카이브(`.tar.gz`) 내부 구조:

```
proxmox-backup-20260221_020000/
├── db.dump       ← PostgreSQL 전체 덤프 (pg_dump -Fc 커스텀 포맷)
├── config.json   ← SystemConfig 테이블 전체 (메뉴/라벨/정책 등 설정)
└── info.json     ← 백업 메타데이터 (생성 시각, 앱 버전, DB 호스트 등)
```

> `db.dump`는 모든 테이블(사용자, 그룹, VM, 감사로그 등)을 포함합니다.
> `config.json`은 설정만 별도 복구할 때 사용됩니다.

**백업에 포함되지 않는 항목:**
- Redis 세션 데이터 (`./servers/redis/data/`) — 세션은 서비스 재시작 시 자동 초기화됨
- `.env` 파일 — 수동으로 별도 보관 권장
- Nginx SSL 인증서 — 수동으로 별도 보관 권장

---

## 5. 웹 UI — 백업 탭 진입

1. 관리자 계정으로 로그인
2. 상단 헤더 **Admin** 버튼 클릭 → 관리자 패널 진입
3. 상단 탭 중 **Settings** (⚙️) 클릭
4. 드롭다운에서 **백업 & 복구** 선택

또는 URL로 직접 이동: `/admin` → Settings → 백업 & 복구

---

## 6. 수동 백업 생성

**순서:**

1. 백업 탭 진입
2. **"지금 백업 생성"** 카드에서 `💾 백업 생성` 버튼 클릭
3. 버튼이 "생성 중..."으로 변경되고 pg_dump 실행
4. 완료 후 생성된 파일명이 표시됨 (예: `proxmox-backup-20260221_143022.tar.gz`)
5. 백업 목록이 자동 갱신됨

> pg_dump 실행 시간은 DB 크기에 따라 수 초 ~ 수십 초 소요됩니다.
> 생성 중에는 버튼이 비활성화되므로 중복 클릭되지 않습니다.

---

## 7. 자동 백업 스케줄 설정

**순서:**

1. 백업 탭 진입
2. **"자동 백업 스케줄"** 카드에서 설정

| 항목 | 옵션 | 기본값 |
|------|------|--------|
| 활성화 | 체크박스 | 비활성 |
| 백업 주기 | 매일 / 매주 | 매일 |
| 보존 기간 | 7일 / 14일 / 30일 | 7일 |

3. `스케줄 저장` 버튼 클릭
4. **마지막 백업** 시각이 하단에 표시됨

**동작 방식:**
- 앱 서버가 10분마다 스케줄을 확인합니다.
- `daily`는 설정된 시각(시 단위)에 하루 1회 실행되며, `weekly`는 선택한 요일/시각에 실행됩니다.
- 보존 기간을 초과한 오래된 백업 파일은 자동 삭제됩니다.
- 스케줄 설정은 DB(`SystemConfig` 테이블, `key = 'backup_schedule'`)에 저장됩니다.
- 앱 재시작 후에도 설정이 유지됩니다.

**확인:**

```bash
# DB에서 스케줄 설정 직접 조회
docker compose exec postgres psql -U proxmox -c \
  "SELECT value FROM \"SystemConfig\" WHERE key = 'backup_schedule';"
```

---

## 8. 백업 목록 확인 및 다운로드

**백업 목록 테이블** (서버에 저장된 파일 기준):

| 컬럼 | 설명 |
|------|------|
| 파일명 | `proxmox-backup-YYYYMMDD_HHmmss.tar.gz` |
| 크기 | 압축 후 파일 크기 (일반적으로 수 MB ~ 수십 MB) |
| 생성일 | 백업 생성 시각 |
| 작업 | ↓ 다운로드 / ↩ 복구 / 🗑 삭제 |

**다운로드:**
- `↓` 버튼 클릭 → 브라우저에서 `.tar.gz` 파일 직접 다운로드
- 다운로드한 파일은 외부 백업 서버 보관 또는 다른 인스턴스 복구에 사용 가능
- 다운로드는 `fetch + blob` 방식으로 처리되어, 새 탭/새 페이지 전환 없이 현재 관리자 화면에서 바로 저장됩니다.
- 따라서 다운로드 시 흰 화면으로 잠깐 전환되는 현상 없이 동일 화면 상태를 유지합니다.

**목록 새로고침:**
- 목록 제목 옆 새로고침(↺) 버튼 또는 탭을 다시 클릭

---

## 9. 복구 — 서버 백업에서 바로 복구

서버에 저장된 백업 파일을 다운로드 없이 즉시 복구합니다.

**순서:**

1. 백업 목록에서 복구할 파일의 `↩` (복구) 버튼 클릭
2. 복구 모달 팝업 확인:
   - 파일명 확인
   - **복구 유형** 선택 (아래 [10절](#10-복구-유형-비교-설정-복구-vs-전체-db-복구) 참조)
3. 전체 DB 복구 선택 시 경고 배너 표시
4. `복구 실행` 버튼 클릭
5. 전체 DB 복구 시 **이중 확인 창** 표시 (실수 방지)
6. 복구 진행 → 결과 메시지 확인

---

## 10. 복구 — 외부 파일 업로드 복구

다른 서버에서 다운로드한 백업 또는 로컬에 보관 중인 백업을 업로드하여 복구합니다.

**순서:**

1. 백업 탭 맨 아래 **"백업에서 복구"** 카드
2. `백업 파일 (.tar.gz)` 항목에서 파일 선택
3. **복구 유형** 선택
4. `복구 실행` 버튼 클릭
5. 결과 메시지 확인

**주의:**
- 파일 크기 제한: **500MB** (일반적인 백업 파일은 이 범위를 넘지 않음)
- `.tar.gz` 확장자 파일만 허용

---

## 11. 복구 유형 비교: 설정 복구 vs 전체 DB 복구

| 항목 | 설정 복구 (Config Only) | 전체 DB 복구 (Full DB) |
|------|------------------------|----------------------|
| **복구 대상** | SystemConfig 테이블만 | PostgreSQL DB 전체 |
| **포함 내용** | 메뉴 설정, 라벨, 알림, 비밀번호 정책 등 | 사용자, 그룹, VM, 감사로그, 설정 전부 |
| **서비스 재시작** | ❌ 불필요 | ✅ 자동 재시작 (Docker restart policy) |
| **현재 세션** | 유지 | 전부 종료됨 |
| **데이터 손실 위험** | 없음 (설정값만 덮어씀) | 현재 DB 전체 삭제 후 복원 |
| **권장 상황** | 메뉴/UI 설정 실수 복구 | 장애 복구, 인스턴스 마이그레이션 |

> ⚠️ **전체 DB 복구는 되돌릴 수 없습니다.**
> 복구 전 반드시 현재 상태의 백업을 먼저 생성하세요.

**전체 DB 복구 후 흐름:**

```
복구 실행
  → pg_restore 실행 (약 10~60초)
  → 앱 프로세스 종료 (process.exit)
  → Docker restart policy(unless-stopped)에 의해 자동 재시작
  → Prisma 마이그레이션 재적용
  → 약 30~60초 후 서비스 복구
```

서비스 복구 확인:
```bash
docker compose ps
docker compose logs app --tail=20
```

---

## 12. CLI 백업/복구 (scripts/)

두 가지 CLI 스크립트가 제공됩니다:

| 스크립트 | 용도 | 백업 저장 위치 |
|---------|------|--------------|
| `scripts/backup-db.sh` | 웹 UI와 동일 포맷 — 백업 생성/목록/삭제/정리 | `./servers/backups/` |
| `scripts/restore-db.sh` | 복구 전용 스크립트 (대화형/비대화형) | `./servers/backups/` |

---

### 11.0 backup-db.sh — DB 백업 관리 (웹 UI와 동일 포맷)

웹 UI와 동일한 `.tar.gz` 포맷으로 백업/복구를 수행합니다.
CLI로 생성한 백업이 웹 UI 목록에도 표시되며, 웹 UI에서 만든 백업도 CLI로 복구 가능합니다.

```bash
# 백업 생성
bash scripts/backup-db.sh create

# 백업 목록 조회
bash scripts/backup-db.sh list

# 설정만 복구 (서비스 재시작 없음)
bash scripts/backup-db.sh restore proxmox-backup-20260221_143022.tar.gz

# 전체 DB 복구 (앱 컨테이너 재시작)
bash scripts/backup-db.sh restore proxmox-backup-20260221_143022.tar.gz full

# 30일 초과 백업 자동 정리
bash scripts/backup-db.sh prune 30

# 특정 백업 삭제
bash scripts/backup-db.sh delete proxmox-backup-20260210_020000.tar.gz

# 도움말
bash scripts/backup-db.sh help
```

> **전체 DB 복구 안전장치**: `full` 복구 실행 시 현재 상태를 자동으로 먼저 백업한 뒤 진행합니다.
> 복구가 잘못된 경우 생성된 `proxmox-backup-pre-restore-*.tar.gz` 파일로 되돌릴 수 있습니다.

**cron으로 자동화 예시 (`crontab -e`):**
```bash
# 매일 새벽 2시 백업 생성, 30일 초과분 자동 삭제
0 2 * * * cd /path/to/proxmox && bash scripts/backup-db.sh create && bash scripts/backup-db.sh prune 30
```

---

### 11.1 restore-db.sh — DB 복구 전용 스크립트

`backup-db.sh`로 생성하거나 웹 UI에서 다운로드한 `.tar.gz` 파일을 복구합니다.
**대화형 모드**를 지원하여 목록에서 번호를 선택하는 방식으로 사용할 수 있습니다.

#### 대화형 모드 (권장)

```bash
bash scripts/restore-db.sh
```

실행 시 백업 목록이 번호와 함께 표시됩니다:

```
No.  파일명                                              크기     생성일
──────────────────────────────────────────────────────────────────────────
1.   proxmox-backup-20260221_143022.tar.gz            2.3M     2026-02-21 14:30:22
2.   proxmox-backup-20260220_020000.tar.gz            2.1M     2026-02-20 02:00:00

복구할 백업 번호를 입력하세요 (1-2, q=취소): 1

복구 유형을 선택하세요:
  1) Config 복구  — SystemConfig 설정만 적용 (재시작 없음)
  2) 전체 DB 복구 — PostgreSQL 전체 복구 (앱 재시작)

선택 (1 또는 2, q=취소): 1
```

#### 비대화형 모드 (자동화/스크립트 연동)

```bash
# 백업 목록만 확인
bash scripts/restore-db.sh --list

# 설정(Config)만 복구 — 서비스 재시작 없음
bash scripts/restore-db.sh proxmox-backup-20260221_143022.tar.gz

# 전체 DB 복구 — 앱 컨테이너 재시작
bash scripts/restore-db.sh proxmox-backup-20260221_143022.tar.gz full

# 도움말
bash scripts/restore-db.sh --help
```

#### 전체 DB 복구 시 동작 순서

1. 현재 상태의 **안전 백업 자동 생성** (`proxmox-backup-pre-restore-*.tar.gz`)
2. 앱 컨테이너 일시 중지 (`docker compose stop app`)
3. `pg_restore --clean --if-exists` 실행
4. 앱 컨테이너 재시작 (`docker compose start app`)
5. 복구 결과 검증 (테이블 수, SystemConfig 레코드 수 확인)

> **복구 실패 대비**: 자동 생성된 안전 백업 파일로 즉시 재복구 가능합니다.
> ```bash
> bash scripts/restore-db.sh proxmox-backup-pre-restore-20260221_143022.tar.gz full
> ```

---

### 11.2 DB 수동 백업 (raw)

```bash
# pg_dump (custom 포맷)
docker compose exec postgres pg_dump -U proxmox -Fc proxmox \
  > ./servers/postgres/backups/manual-$(date +%Y%m%d).dump

# SQL 텍스트 포맷
docker compose exec postgres pg_dump -U proxmox proxmox \
  > ./servers/postgres/backups/manual-$(date +%Y%m%d).sql
```

### 11.3 DB 수동 복구 (raw)

```bash
# custom 포맷 복구
docker compose exec -T postgres pg_restore \
  -U proxmox -d proxmox --clean --if-exists \
  < ./servers/postgres/backups/manual-20260221.dump

# SQL 포맷 복구
docker compose exec -T postgres psql -U proxmox proxmox \
  < ./servers/postgres/backups/manual-20260221.sql
```

---

## 13. 백업 파일 구조

```
proxmox-backup-20260221_143022.tar.gz
└── tmp-20260221143022/         (압축 해제 시 폴더명)
    ├── db.dump                 PostgreSQL custom format dump
    │                           → pg_restore로 복구 가능
    ├── config.json             SystemConfig 테이블 전체 (JSON 배열)
    │                           [{ "key": "menu_config", "value": "{...}" }, ...]
    └── info.json               백업 메타데이터
                                {
                                  "createdAt": "2026-02-21T14:30:22.000Z",
                                  "appVersion": "1.0.0",
                                  "host": "https://your-domain.com",
                                  "dbHost": "postgres",
                                  "dbName": "proxmox"
                                }
```

**config.json에 포함되는 SystemConfig 키:**

| 키 | 내용 |
|----|------|
| `menu_config` | 헤더/탭/사이드바 메뉴 구조 |
| `section_labels` | 섹션 제목/아이콘/설명 |
| `ui_elements` | 버튼, 테이블 헤더 정의 |
| `labels_ko` / `labels_en` | 언어별 라벨 오버라이드 |
| `ui_strings_overrides` | UI 텍스트 커스터마이징 |
| `password_policy` | 비밀번호 정책 |
| `auto_rotate_policy` | SSH 키 자동 교체 정책 |
| `backup_schedule` | 자동 백업 스케줄 설정 |

---

## 14. 주의사항 및 트러블슈팅

### ⚠️ 중요 경고

1. **전체 DB 복구는 현재 데이터를 모두 삭제합니다.**
   복구 전 반드시 `💾 백업 생성`을 먼저 실행하세요.

2. **KEY_ENCRYPTION_SECRET이 다르면 복구된 암호화 데이터를 복호화할 수 없습니다.**
   다른 인스턴스로 마이그레이션 시 `.env`의 `KEY_ENCRYPTION_SECRET`을 동일하게 유지해야 합니다.

3. **서비스 재시작 중 접속 불가 시간이 발생합니다.**
   전체 DB 복구 후 약 30~60초간 서비스가 중단됩니다.

### 트러블슈팅

#### 백업 생성 실패: "Cannot parse DATABASE_URL for backup"
```bash
# .env에서 DATABASE_URL 형식 확인
cat .env | grep DATABASE_URL
# 올바른 형식: postgresql://proxmox:PASSWORD@postgres:5432/proxmox
```

#### 백업 생성 실패: pg_dump 명령어를 찾을 수 없음
```bash
# 앱 컨테이너 재빌드 (postgresql-client 포함)
docker compose up -d --build
```

#### 백업 디렉토리 권한 오류
```bash
# 호스트에서 권한 부여
chmod 755 ./servers/backups
# 컨테이너 재시작
docker compose restart app
```

#### 전체 DB 복구 후 서비스가 재시작되지 않음
```bash
# Docker restart policy 확인
docker inspect proxmox-app | grep RestartPolicy
# 수동 재시작
docker compose restart app
```

#### 복구 후 로그인이 되지 않음
- 복구된 백업 시점의 비밀번호로 로그인해야 합니다.
- OTP 시크릿도 백업 시점으로 복원됩니다. OTP 앱의 시크릿이 달라진 경우 관리자가 OTP 초기화를 수행해야 합니다.

#### 백업 파일이 목록에 보이지 않음
```bash
# 호스트에서 파일 존재 확인
ls -la ./servers/backups/

# 볼륨 마운트 확인
docker compose exec app ls -la /app/backups/
```

---

## 관련 파일

| 파일 | 역할 |
|------|------|
| `app/src/utils/backup.ts` | 백업/복구 핵심 로직 (pg_dump, pg_restore, 파일 관리) |
| `app/src/services/backupScheduler.ts` | 자동 백업 스케줄러 |
| `app/src/routes/api/admin.ts` | 백업 API 엔드포인트 |
| `app/src/views/admin.ejs` | 백업 탭 UI |
| `app/Dockerfile` | postgresql-client 포함 |
| `docker-compose.yml` | `./servers/backups:/app/backups` 볼륨 마운트 |
| `scripts/backup-db.sh` | CLI 백업 생성/목록/삭제/정리 |
| `scripts/restore-db.sh` | CLI 복구 전용 스크립트 |

---

## 작성자

| 항목 | 내용 |
|------|------|
| 작성자 | Nexus Dev LeeSangha |
| 문의 | lee.sangha@lotte.net |
| 버전 | Proxmox Horizon v2.0.0 |
