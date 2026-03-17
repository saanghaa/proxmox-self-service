# Proxmox Horizon 설치 매뉴얼 (세팅/운영 관점 + 시행착오 포함)

이 문서는 “처음 설치(Init)”부터 “운영 배포(Deploy)”까지의 절차를, 이번에 실제로 겪었던 문제/해결책까지 포함해 정리합니다.  
설명은 현재 저장소 스크립트/코드 기준입니다.

## 0. 구성 요약

### 0.1 서비스 구성(Docker Compose)

Compose 파일:
- `proxmox/docker-compose.yml`

서비스:
- `nginx` (80/443 리버스 프록시)
- `app` (Node.js/Express + EJS + Prisma)
- `postgres` (DB)
- `redis` (캐시/세션 보조)

핵심 환경변수(.env):
- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `SESSION_SECRET`
- `KEY_ENCRYPTION_SECRET`
- `BASE_URL` (옵션)
- `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` (초기 시드용)

참고: 예시 파일
- `proxmox/.env.example`

### 0.2 작업 위치 구분표

설치 과정은 한 머신에서만 끝나지 않습니다.  
아래 표처럼 **어느 서버에서 어떤 명령을 실행하는지**를 먼저 구분하고 진행해야 합니다.

| 위치 | 역할 | 여기서 실행하는 것 |
|---|---|---|
| 개발 PC / 관리 PC | 저장소 수정, 릴리스 패키지 생성, 스크립트 복사 | `scp`, `bash scripts/make-release-tar.sh` |
| Proxmox Horizon 앱 서버 | Docker Compose로 앱 설치/업데이트 | `bash install.sh`, `bash deploy.sh`, `docker compose ...` |
| Proxmox VE 호스트 | 스토리지 content 설정, Cloud Image 다운로드, 토큰 생성 | `proxmox-enable-content.sh`, `proxmox-download-cloud-image.sh`, `proxmox-token-rotate.sh` |

중요:
- `install.sh`, `deploy.sh`는 **Proxmox Horizon 앱 서버**에서 실행합니다.
- `proxmox-enable-content.sh`, `proxmox-download-cloud-image.sh`, `proxmox-token-rotate.sh`는 **Proxmox VE 호스트**에서 실행합니다.
- Proxmox에는 일반적으로 `sudo`가 없으므로, Proxmox VE 호스트 작업은 **root 계정**으로 직접 수행합니다.

## 1. 설치 방식 선택: install.sh vs deploy.sh

### 1.1 최초 설치(Init): `install.sh`

스크립트:
- `proxmox/install.sh`

목표:
- 호스트에 npm/빌드툴을 강요하지 않고, Docker build로 앱을 빌드
- 도메인/localhost 하드코딩 없이 동작(필요 시 `BASE_URL`만 설정)

기본 사용:
```bash
cd proxmox
bash install.sh
```

완전 초기화(데이터 삭제 후 재설치):
```bash
cd proxmox
bash install.sh --init
```

초기 관리자 계정 지정(옵션):
```bash
cd proxmox
bash install.sh --init --user proxmox@proxmox.io --passwd 'Proxmox1!'
```

설명:
- `--user/--passwd`는 “새 .env 생성 시” 초기 관리자 시드에 사용됩니다.
- 초기 비밀번호는 첫 로그인 후 “비밀번호 변경 + OTP 등록” 절차를 유도하는 흐름으로 설계되어 있습니다(`proxmox/app/src/routes/auth.ts`).
- 초기 UI 테마 템플릿 기본값은 `proxmox`로 시드됩니다 (`proxmox/app/prisma/seed.ts`).
- 테마 선택은 로그인 후 헤더의 **개인설정** 메뉴에서 사용자별로 저장됩니다 (`/api/theme-template`).

### 1.2 운영 반영(rolling update): `deploy.sh`

스크립트:
- `proxmox/deploy.sh`

목표:
- 데이터 유지 + 소스 변경 반영(빌드/교체) + Prisma 스키마 동기화

사용:
```bash
cd proxmox
bash deploy.sh
```

캐시 없이 앱 이미지만 강제 리빌드:
```bash
cd proxmox
DEPLOY_NO_CACHE=1 bash deploy.sh
```

## 2. 설치 전 준비(필수)

### 2.1 호스트 요구사항

- Ubuntu/Debian 권장
- `sudo` 사용 가능
- 외부에서 접근할 경우 방화벽(80/443) 오픈

Docker/Compose는 `install.sh`에서 자동 설치합니다.

### 2.2 BASE_URL 정책(하드코딩 금지)

코드 정책:
- `BASE_URL`은 **옵션**입니다.
- 비워도(reverse proxy에서) 도메인/아이피가 무엇이든 동작하도록 설계되어야 합니다.

설정 위치:
- `.env`의 `BASE_URL=`

권장:
- 운영에서 절대 링크/메일 링크 등을 “항상 한 도메인”으로 만들고 싶으면 `BASE_URL=https://portal.example.com` 설정.
- IP/도메인이 바뀔 수 있는 환경이면 비워두고, Nginx에서 Host 헤더를 유지하도록 구성.

## 2.3 DB 스키마 마이그레이션

`docker-entrypoint.sh`가 컨테이너 시작 시 `prisma db push --accept-data-loss`를 자동 실행하여 `schema.prisma` 변경사항을 DB에 반영합니다. 별도 수동 마이그레이션 없이 rebuild 후 재시작만으로 스키마가 동기화됩니다.

### 주요 마이그레이션 이력

| 파일 | 내용 |
|---|---|
| `001_add_system_config.sql` | SystemConfig 테이블 |
| `002_add_vm_soft_delete.sql` | Vm soft delete 필드 |
| `003_add_password_reset_fields.sql` | 임시 비밀번호 필드 |
| `005_add_vm_status.sql` | Vm.status 필드 |
| `006_add_windows_credentials.sql` | Windows 자격증명 필드 |
| `007_add_vm_last_rotated_at.sql` | Vm.lastRotatedAt 필드 |
| `008_add_vm_disk_table.sql` | VmDisk 테이블 (디스크 슬롯별 개별 관리) |

> `prisma db push` 방식이므로 수동 SQL 실행 없이 rebuild 시 자동 적용됩니다.
> `--accept-data-loss` 플래그가 포함되어 있어 컬럼 제거/타입 변경도 자동 처리됩니다.

## 3. 자주 터진 문제와 해결(시행착오 모음)

### 3.1 OTP 화면(/auth/otp-setup) 500 Internal Server Error

증상:
- 브라우저에서 `/auth/otp-setup` 진입 시 500
- 앱 로그에 EJS ReferenceError

원인(코드 레벨):
- EJS 템플릿이 `error` 변수를 “전달받지 않았는데” 직접 참조하면 EJS가 ReferenceError를 던집니다.
  - 예: `proxmox/app/src/views/otp-setup.ejs` 내 `<% if (error) { %> ...`

해결 원칙:
1) 템플릿을 안전하게:
   - `locals && locals.error` 방식, 또는
   - 라우트가 항상 `error: null`을 넘기도록 수정
2) 소스 변경 후 반드시 재빌드:
   - `DEPLOY_NO_CACHE=1 bash deploy.sh` 권장

점검 경로:
- 템플릿: `proxmox/app/src/views/otp-setup.ejs`
- 라우트: `proxmox/app/src/routes/auth.ts`

로그 확인:
```bash
sudo docker compose logs --tail=200 app
```

### 3.2 Prisma P1000(DB 인증 실패) / DATABASE_URL에 '@'가 2개 이상

증상:
- `deploy.sh` 또는 `prisma db push`에서
  - `P1000: Authentication failed ...`
- 또는 `DATABASE_URL`에 `@`가 2개 이상 포함되어 파싱 오류

원인:
- DB 비밀번호에 `@` 같은 문자가 들어가면 `DATABASE_URL`에서 URL 인코딩이 필요합니다.

현재 대응(스크립트 내 자동 수정):
- `proxmox/install.sh` / `proxmox/deploy.sh`
  - `POSTGRES_PASSWORD`를 URL-encode해서 `DATABASE_URL`을 자동 보정

수동 예:
```env
POSTGRES_PASSWORD=MyP@ss
DATABASE_URL=postgresql://proxmox:MyP%40ss@postgres:5432/proxmox
```

### 3.3 Proxmox “Cloud Image (Import Storage)” 목록이 비어 있음 / 추가 디스크 자동 마운트 실패

핵심 결론:
- **파일이 `/var/lib/vz/import`에 존재하는 것만으로는 안 됩니다.**
- Proxmox 스토리지 설정(`/etc/pve/storage.cfg`)의 `content`에 `import`가 포함되어야
  - `pvesm list <storage> --content import`
  - `/nodes/<node>/storage/<storage>/content?content=import`
  에서 “import 컨텐츠”로 노출됩니다.
- VM 배포 시 cloud-init vendor-data로 **사전 배치된 스니펫 파일**을 항상 참조합니다(`cicustom`).
  - 기본 파일명: `proxmox-cloud-init.yaml`
  - 기본 경로: `/var/lib/vz/snippets/proxmox-cloud-init.yaml`
  - 모든 VM에서 `cicustom`이 적용되며(추가 디스크 유무와 무관), 추가 디스크 마운트만 디스크 존재 시 동작합니다.
  - 현재 배포 경로에서는 요청/승인 시 입력한 `sshPort`가 동적으로 스니펫에 반영되지 않습니다. 실제 SSH 포트는 스니펫 파일의 포트 설정값(기본 2211)을 따릅니다.
- 스니펫이 수행하는 작업:
  - `qemu-guest-agent` 설치 및 활성화
  - SSH 포트 변경 (기본: 2211) + SSH 보안 설정
  - 추가 디스크 자동 마운트 (`/data`, `/data2`, ...)
  - 방화벽 설정 (Ubuntu: ufw, Rocky: firewalld)
  - Rocky Linux의 경우 SELinux 비활성화
  - 설정 완료 후 자동 리부트
- 동일 스토리지의 `content`에 `snippets`가 포함되어야 합니다.

확인:
```bash
cat /etc/pve/storage.cfg
pvesm status
pvesh get /nodes/<node>/storage/local/content
pvesh get /nodes/<node>/storage/local/content --content import
```

권장 설정(예: local 스토리지):
```conf
dir: local
  path /var/lib/vz
  content iso,vztmpl,backup,import,snippets
```

### Proxmox 호스트 셸 스크립트 가이드

> **중요**: Proxmox에는 `sudo`가 없습니다. 모든 스크립트는 **root 계정**으로 직접 실행합니다.
> 스크립트 파일은 `proxmox/scripts/` 디렉토리에 있습니다. Proxmox 호스트에 복사 후 실행하세요.

#### 실행 위치와 순서 요약

아래 3개 스크립트는 **웹 앱 서버가 아니라 Proxmox VE 호스트에서** 실행합니다.

먼저 “이 스크립트가 무엇을 하는지”를 짧게 보면 아래와 같습니다.

| 스크립트 | 무엇을 하는가 | 언제 실행하는가 |
|---|---|---|
| `proxmox-enable-content.sh` | Proxmox 스토리지의 `import`, `snippets` content를 활성화하고, VM 초기화용 cloud-init 스니펫 파일을 생성합니다. | 최초 세팅 시 가장 먼저 |
| `proxmox-download-cloud-image.sh` | 배포에 사용할 Ubuntu / Rocky Cloud Image를 Proxmox import 스토리지에 다운로드합니다. | 스토리지 준비 후 |
| `proxmox-token-rotate.sh` | Horizon이 Proxmox API에 접근할 수 있도록 API Token을 생성하거나 교체합니다. | 최초 연결 전, 또는 토큰 교체 시 |

권장 순서:
1. Proxmox Horizon 저장소의 `scripts/` 파일을 Proxmox VE 호스트로 복사
2. Proxmox VE 호스트에서 `proxmox-enable-content.sh` 실행
3. Proxmox VE 호스트에서 `proxmox-download-cloud-image.sh` 실행
4. Proxmox VE 호스트에서 `proxmox-token-rotate.sh` 실행
5. 생성된 Token ID / Token Secret을 Proxmox Horizon 관리자 화면에 등록

예시:

```bash
# 1) 개발 PC 또는 앱 서버에서 Proxmox 호스트로 스크립트 복사
scp scripts/proxmox-enable-content.sh root@10.10.20.120:/root/
scp scripts/proxmox-download-cloud-image.sh root@10.10.20.120:/root/
scp scripts/proxmox-token-rotate.sh root@10.10.20.120:/root/

# 2) Proxmox VE 호스트에 접속
ssh root@10.10.20.120

# 3) Proxmox VE 호스트에서 실행 권한 부여
chmod +x /root/proxmox-enable-content.sh
chmod +x /root/proxmox-download-cloud-image.sh
chmod +x /root/proxmox-token-rotate.sh

# 4) 이후 모든 명령은 Proxmox VE 호스트에서 실행
cd /root
```

클러스터 환경 팁:
- `proxmox-enable-content.sh`와 `proxmox-download-cloud-image.sh`는 **실제 배포 대상 스토리지를 가진 노드**에서 확인해야 합니다.
- 토큰 생성은 보통 기준 노드 1대에서 수행한 뒤, 해당 Token ID / Token Secret으로 Horizon에 등록합니다.
- Horizon이 클러스터를 자동 탐지하더라도, **Cloud Image와 snippets 준비는 Proxmox 쪽에서 먼저 끝나 있어야** 정상 배포됩니다.

#### 1) `proxmox-enable-content.sh` — 스토리지 설정 + Cloud-init 스니펫 생성

**목적**: Proxmox local 스토리지에 `import`/`snippets` content를 활성화하고, VM 초기화용 cloud-init 스니펫 파일(`proxmox-cloud-init.yaml`)을 생성합니다.

즉, 이 스크립트는 다음 문제를 한 번에 해결합니다.
- Horizon에서 Cloud Image 목록이 안 보이는 문제
- 배포 시 `cicustom` / snippet 관련 실패가 나는 문제
- VM 최초 부팅 시 Guest Agent, SSH 포트, 추가 디스크 마운트가 표준화되지 않는 문제

**스니펫이 하는 일**:
- `qemu-guest-agent` 설치 및 활성화
- SSH 포트 변경 (기본: 2211) + SSH 보안 설정
- 추가 디스크 자동 포맷/마운트 (`/data`, `/data2`, ...)
- 방화벽 설정 (Ubuntu: ufw, Rocky: firewalld)
- Rocky Linux SELinux 비활성화
- 설정 완료 후 자동 리부트

**사용법**:
```bash
# [권장] 전체 설정 한번에 (import + snippets 활성화 + 스니펫 파일 생성)
./proxmox-enable-content.sh --all

# SSH 포트를 커스텀 지정 (기본값: 2211)
./proxmox-enable-content.sh --all --ssh-port 2211

# 스니펫 파일이 이미 있어도 최신 내용으로 덮어쓰기
./proxmox-enable-content.sh --all --force-snippet

# 특정 스토리지 지정
./proxmox-enable-content.sh --all --storage local

# 대화형 모드 (하나씩 선택)
./proxmox-enable-content.sh --interactive

# 변경 없이 미리보기만
./proxmox-enable-content.sh --storage local --dry-run
```

#### 2) `proxmox-download-cloud-image.sh` — Cloud Image 다운로드

**목적**: Proxmox의 `download-url` API를 통해 Cloud Image를 import 스토리지에 다운로드합니다.

즉, 이 스크립트는 Horizon 승인 화면에서 선택할 수 있는 “배포용 OS 이미지”를 Proxmox에 미리 준비하는 역할입니다.

이 스크립트를 실행하지 않으면:
- 관리자 승인 화면에서 선택할 Cloud Image가 없을 수 있고
- 배포가 시작되더라도 이미지 미존재로 실패할 수 있습니다

**지원 프리셋**:
| 프리셋 | OS | 형식 |
|---|---|---|
| `ubuntu-noble` | Ubuntu 24.04 LTS | `.img` → `.raw` |
| `rocky-10` | Rocky Linux 10 | `.qcow2` |

**사용법**:
```bash
# Ubuntu 24.04 다운로드
./proxmox-download-cloud-image.sh --preset ubuntu-noble --node pve01 --storage local

# Rocky Linux 10 다운로드
./proxmox-download-cloud-image.sh --preset rocky-10 --node pve01 --storage local

# 커스텀 URL로 다운로드
./proxmox-download-cloud-image.sh --node pve01 --storage local --url https://example.com/image.qcow2

# 프리셋 목록 확인
./proxmox-download-cloud-image.sh --list-presets

# 미리보기
./proxmox-download-cloud-image.sh --preset ubuntu-noble --node pve01 --dry-run
```

#### 3) `proxmox-token-rotate.sh` — API 토큰 생성/회전

**목적**: Proxmox가 Proxmox API에 접근할 때 사용하는 토큰을 생성하거나 갱신합니다.

즉, 이 스크립트는 Horizon이 Proxmox에 로그인해서:
- 노드 연결 테스트를 하고
- VM 목록과 스토리지를 조회하고
- 실제 VM 생성/삭제/상태 조회를 수행할 수 있게 만드는 자격증명을 준비합니다.

이 스크립트를 실행하지 않으면:
- `PROXMOX 서버 연결`에서 테스트가 실패하고
- 클러스터 자동 탐지나 VM 배포도 수행할 수 없습니다

**사용법**:
```bash
# 기본값 (proxmox@pam, 토큰명 proxmox)
./proxmox-token-rotate.sh

# 사용자/토큰명 지정
./proxmox-token-rotate.sh proxmox@pam proxmox
```

출력된 Token ID와 Token Secret을 Proxmox 관리자 페이지의 Proxmox 노드 설정에 입력합니다.

#### 초기 세팅 순서 (권장)

```bash
# 아래 명령은 모두 Proxmox VE 호스트(root)에서 실행

# 1. Horizon이 import/snippets를 읽고 cloud-init 스니펫을 쓸 수 있게 준비
./proxmox-enable-content.sh --all

# 2. 실제 배포에 사용할 OS 이미지를 Proxmox에 다운로드
./proxmox-download-cloud-image.sh --preset ubuntu-noble --node pve01 --storage local
./proxmox-download-cloud-image.sh --preset rocky-10 --node pve01 --storage local

# 3. Horizon이 Proxmox API를 호출할 토큰 생성
./proxmox-token-rotate.sh
```

#### 검증

```bash
# 아래 명령도 Proxmox VE 호스트(root)에서 실행

# 스토리지 content 확인
pvesh get /storage/local --output-format json | jq -r '.content'

# import/snippets 목록 확인
pvesm list local --content import
pvesm list local --content snippets

# 스니펫 파일 확인
ls -l /var/lib/vz/snippets/proxmox-cloud-init.yaml
```

#### 참고사항
- 현재 운영 가이드는 Ubuntu/Rocky 2개 OS를 기준으로 검증되었습니다.
- 앱 배포 경로에서는 Cloud Image 자동 다운로드를 수행하지 않습니다(사용자 선택 필수).
- Rocky Linux VM은 cloud-init에서 SELinux를 비활성화합니다(비표준 SSH 포트 차단 방지).
- Proxmox 9.1 환경에서는 snippet API 업로드가 지원되지 않습니다. 사전 배치된 파일만 사용합니다.
- storage content에 `snippets`가 없으면, 배포 로그에 cloud-init snippet 관련 실패가 나타나고 Deploy 결과가 `PARTIAL`로 떨어질 수 있습니다.
- 즉, **앱 설치가 끝났더라도 Proxmox 호스트 준비가 안 되어 있으면 배포는 실패하거나 PARTIAL이 됩니다.**

#### Horizon 관리자 화면까지 연결하는 마지막 단계

Proxmox VE 호스트에서 준비가 끝났으면, 이제 **Proxmox Horizon 관리자 화면**에서 아래 순서로 연결합니다.

1. 관리자 로그인
2. `설정` 탭 이동
3. `PROXMOX 서버 연결` 열기
4. 기준 노드의 관리 IP 또는 URL 입력
5. `proxmox-token-rotate.sh` 출력의 `Token ID`, `Token Secret` 입력
6. 노드 추가 실행

입력 예:
- Host: `10.10.20.120` 또는 `https://10.10.20.120:8006`
- Token ID: `root@pam!proxmox` 또는 생성한 사용자 기준 Token ID
- Token Secret: 스크립트 출력값

중요:
- Host는 **관리망 주소**를 넣어야 합니다.
- 콤마가 들어간 `10,10,20,120` 같은 형식은 잘못된 주소입니다.
- 클러스터 자동 등록이 되더라도, 잘못된 내부 전용 주소가 잡히면 수정이 필요할 수 있습니다.

### 3.4 게이트웨이 자동 감지가 “게이트웨이”가 아니라 “브릿지 IP”로 들어감

증상:
- UI에서 `Gateway (Auto Detected)`가 브릿지 주소(예: `192.168.0.100`)로 채워짐

원칙:
- 가능하면 Proxmox API에서 gateway 값을 가져오고, 없으면 “네트워크+1” 추정 로직을 사용합니다.

관련 코드:
- 브릿지 조회/메타: `proxmox/app/src/routes/api/deploy.ts` (`/api/deploy/nodes/:id/bridges`)
- UI 자동 채움: `proxmox/app/src/views/admin.ejs`

운영 팁:
- 실제 환경에서 `.254` 같은 게이트웨이를 사용한다면
  - Proxmox 쪽 네트워크 설정(게이트웨이 정보)을 정확히 유지하는 것이 가장 안전합니다.

### 3.5 브라우저 콘솔에 “Tracking Prevention blocked access to storage … jsdelivr …” 경고

원인:
- 외부 CDN(예: `cdn.jsdelivr.net`)에서 로딩하는 리소스 + 브라우저 트래킹 방지 정책 조합으로 경고가 발생할 수 있습니다.

대응:
- 기능상 큰 문제는 없을 수 있습니다(경고만 뜨는 경우).
- 경고/외부 의존을 제거하려면:
  - CDN 링크를 제거하고 정적 파일을 프로젝트의 `public/vendor/`로 옮겨 서빙하도록 정리합니다.
  - 점검 포인트: `proxmox/app/src/views/*.ejs`, `proxmox/servers/nginx/*`

### 3.6 VM 배포 결과가 PARTIAL로 떨어지는 경우(Cloud Image/스니펫)

대표 원인:
- Cloud Image volid 형식 오류(`storage:import/<file>`가 아님)
- 선택한 이미지가 아직 import 스토리지에서 조회되지 않음
- storage content에 `snippets` 미포함(cloud-init vendor-data 적용 불가)

현재 코드 동작:
- `cloudImageVolid`는 필수이며, 비어 있으면 배포를 시작하지 않습니다.
- 선택값은 `storage:import/<file>` 형식을 사용하며, 선택한 volid가 import 컨텐츠에서 조회되는지 확인 후 배포를 계속합니다.
- 사용자 선택값이 `import/...` 형태이면 `<storage>:import/...`로 보정합니다.

관련 코드:
- `proxmox/app/src/services/deployEngine.ts`
- `proxmox/app/src/views/admin.ejs`

## 4. 배포/빌드 규칙(“src 수정했는데 서버가 안 바뀌는” 문제 방지)

중요:
- 컨테이너는 **`/app/dist`**를 실행합니다(빌드 결과물).
- 로컬에서 `app/src`만 바꾸고 배포를 안 하면 서버는 그대로입니다.

반영 절차(권장):
```bash
cd proxmox
DEPLOY_NO_CACHE=1 bash deploy.sh
```

로그 확인:
```bash
sudo docker compose logs -f --tail=200 app
sudo docker compose logs -f --tail=200 nginx
```

## 5. Proxmox 토큰/권한 최소 조건(운영 체크리스트)

PVE 토큰은 VM 생성/삭제/네트워크/스토리지 조회에 필요한 권한이 있어야 합니다.  
연결 테스트 엔드포인트:
- `POST /api/deploy/nodes/:id/test` (`proxmox/app/src/routes/api/deploy.ts`)

운영 확인:
- UI에서 “테스트” 버튼
- 또는 API 호출로 확인(토큰 권한/응답 확인)

## 6. 설치 후 점검(필수)

### 6.1 컨테이너 상태
```bash
sudo docker compose ps
```

### 6.2 웹 응답
```bash
curl -i http://127.0.0.1/auth/login | sed -n '1,15p'
```

### 6.3 초기 관리자 로그인
- `install.sh` 출력 또는 `.env`의 `INITIAL_ADMIN_*` 확인
- 첫 로그인 후:
  1) 비밀번호 변경
  2) OTP 등록
  3) 복구코드 저장

## 7. 운영 스크립트 가이드

> 모든 스크립트는 `proxmox/` 루트에서 실행합니다 (docker-compose.yml이 있는 위치).

### 7.1 DB 백업 (`backup-db.sh`)

웹 UI(관리자 패널 → 백업 탭)와 동일한 포맷으로 백업/복구를 수행합니다.
`./servers/backups/` 디렉토리를 공유하므로 CLI 백업을 웹 UI에서 확인하거나 그 반대도 가능합니다.

**사전 조건**: `docker compose up -d` 상태에서 postgres 컨테이너가 실행 중이어야 합니다.

```bash
# 백업 생성 (db.dump + config.json + info.json → tar.gz)
./scripts/backup-db.sh create

# 백업 목록 조회
./scripts/backup-db.sh list

# 설정 복구 (SystemConfig만, 서비스 재시작 없음 — 권장)
./scripts/backup-db.sh restore proxmox-backup-20260221_143022.tar.gz

# 전체 DB 복구 (앱 재시작, 복구 전 자동 안전 백업 생성)
./scripts/backup-db.sh restore proxmox-backup-20260221_143022.tar.gz full

# 백업 삭제
./scripts/backup-db.sh delete proxmox-backup-20260210_020000.tar.gz

# 30일 초과 백업 자동 정리 (기본 7일)
./scripts/backup-db.sh prune 30

# 도움말
./scripts/backup-db.sh help
```

**백업 파일 구성** (`tar.gz` 내부):

| 파일 | 내용 |
|---|---|
| `db.dump` | PostgreSQL 전체 덤프 (custom 포맷) |
| `config.json` | SystemConfig 테이블 JSON |
| `info.json` | 생성 시각, 호스트, DB 정보 메타데이터 |

### 7.2 DB 복구 (`restore-db.sh`)

대화형 모드를 지원하는 복구 전용 스크립트입니다.
`backup-db.sh restore`와 동일한 기능이며, 번호 선택 UI로 더 편리하게 사용할 수 있습니다.

**사전 조건**: `docker compose up -d` 상태에서 postgres 컨테이너가 실행 중이어야 합니다.

```bash
# 대화형 모드 (목록 번호 선택 + 복구 유형 선택)
./scripts/restore-db.sh

# 백업 목록만 확인
./scripts/restore-db.sh --list

# 설정 복구 (Config Only — 기본값, 서비스 재시작 없음)
./scripts/restore-db.sh proxmox-backup-20260221_143022.tar.gz

# 전체 DB 복구 (앱 컨테이너 일시 중지 후 재시작)
./scripts/restore-db.sh proxmox-backup-20260221_143022.tar.gz full

# 도움말
./scripts/restore-db.sh --help
```

**복구 유형 비교**:

| 유형 | 대상 | 서비스 중단 | 사전 안전 백업 |
|---|---|---|---|
| `config` (기본) | SystemConfig 설정만 | 없음 | 없음 |
| `full` | PostgreSQL 전체 | 앱 일시 중지 | 자동 생성 |

> `full` 복구 시 현재 DB 상태를 `proxmox-backup-pre-restore-*.tar.gz`로 자동 백업한 뒤 진행합니다.

### 7.3 Nginx 로그 로테이션 (`rotate-nginx-logs.sh`)

날짜별 로그 분리 → USR1 신호로 Nginx 재오픈 → gzip 압축 → 90일 초과분 삭제를 순서대로 수행합니다.

**로그 저장 위치**: `servers/nginx/logs/`

```bash
# 즉시 실행
./scripts/rotate-nginx-logs.sh
```

**동작 순서**:
1. `access.log` / `error.log` → `access-YYYYMMDD.log` / `error-YYYYMMDD.log` 로 이름 변경
2. Nginx에 `USR1` 신호 → 새 로그 파일로 재오픈 (서비스 중단 없음)
3. 1일 이상 지난 `.log` 파일 → `.log.gz` 로 gzip 압축
4. 90일 이상 지난 `.log.gz` 파일 삭제

**cron 등록** (매일 자정 자동 실행):
```bash
crontab -e
# 아래 두 줄 추가 (경로는 실제 배포 경로로 수정):
0 0 * * * /opt/proxmox/scripts/rotate-nginx-logs.sh >> /opt/proxmox/servers/nginx/logs/rotation.log 2>&1
0 3 * * * /opt/proxmox/scripts/backup-db.sh create >> /opt/proxmox/servers/backups/backup.log 2>&1
```

### 7.4 OTP 초기화 (`otp-reset.sh`)

SMTP/이메일 복구가 불가능할 때 사용하는 **비상 수단**입니다.
대상 사용자의 TOTP를 비활성화하고 복구 코드를 전부 삭제합니다.

**사전 조건**: `app` 컨테이너가 실행 중이어야 합니다 (`docker compose up -d`).

```bash
./scripts/otp-reset.sh user@example.com
```

**실행 흐름**:
1. 대상 사용자 이메일 확인
2. `Proceed? (y/N)` 확인 프롬프트
3. 트랜잭션으로 처리:
   - `OtpRecoveryCode` 전체 삭제
   - `User.totpSecret = NULL`, `totpEnabled = false`
   - `AuditLog` 에 `OTP_RESET_CLI` 기록
4. 완료 후 사용자가 다음 로그인 시 OTP 없이 진입 → 재등록 유도

### 7.5 감사로그 IP 추적 (`audit-ip-trace.sh`)

AuditLog(DB)와 Nginx access.log를 시간/UA 기준으로 교차 분석합니다.
의심 접근 추적, 보안 감사에 활용합니다.

**사전 조건**: `app`, `nginx` 컨테이너가 실행 중이어야 합니다.

```bash
# 최근 20건 조회 (기본값)
./scripts/audit-ip-trace.sh

# 특정 사용자의 실패 로그 10건
./scripts/audit-ip-trace.sh --limit 10 --user admin@example.com --result FAILURE

# 시간 범위 지정
./scripts/audit-ip-trace.sh --from 2026-02-13T00:00:00Z --to 2026-02-13T23:59:59Z

# 특정 동작 필터 (예: delete)
./scripts/audit-ip-trace.sh --action delete

# nginx 로그를 더 많이 읽어 매칭률 높이기 (기본 3000줄)
./scripts/audit-ip-trace.sh --tail 10000

# 도움말
./scripts/audit-ip-trace.sh --help
```

**옵션 목록**:

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--limit N` | 20 | 가져올 감사로그 개수 |
| `--tail N` | 3000 | Nginx 로그 읽기 줄 수 |
| `--user EMAIL` | - | 사용자 이메일 필터 |
| `--action TEXT` | - | 동작 필터 (부분 일치) |
| `--result VALUE` | - | `SUCCESS` 또는 `FAILURE` |
| `--from ISO` | - | 시작 시각 (예: `2026-02-13T00:00:00Z`) |
| `--to ISO` | - | 종료 시각 |

### 7.6 장애 진단 tarball (`diagnose-internal-error.sh`)

컨테이너 상태, 서비스 로그, Nginx 설정, 앱 빌드 결과 등을 수집해 tarball로 묶습니다.
문제 발생 시 지원팀 제출 또는 원격 디버깅에 활용합니다.

```bash
# docker-compose.yml 이 있는 디렉토리에서 실행
./scripts/diagnose-internal-error.sh
# → diag-YYYYMMDD-HHMMSS.tar.gz 생성
```

**수집 항목**:

| 파일 | 내용 |
|---|---|
| `env.txt` | 환경변수 목록 (시크릿은 `***REDACTED***` 처리) |
| `host_info.txt` | OS, IP, 현재 사용자, 날짜 |
| `resources.txt` | 디스크/메모리/uptime |
| `docker_versions.txt` | Docker, Compose 버전 및 정보 |
| `compose_ps.txt` | 컨테이너 상태 |
| `logs_app.txt` | 앱 로그 최근 400줄 |
| `logs_nginx.txt` | Nginx 로그 최근 400줄 |
| `logs_postgres.txt` | PostgreSQL 로그 최근 250줄 |
| `nginx_T.txt` | `nginx -T` 전체 설정 (240줄) |
| `http_checks.txt` | 주요 경로 HTTP 응답 상태 확인 |

### 7.7 배포용 tarball 생성 (`make-release-tar.sh`)

git 없이 파일을 직접 서버로 전달할 때 사용합니다.
`.env`, `node_modules`, `dist`, 인증서 등 민감/런타임 파일을 제외하고 배포 패키지를 생성합니다.
BUILD_ID(타임스탬프-git커밋해시)와 sha256 체크섬 파일도 함께 생성됩니다.

**패키지 생성 (개발 PC에서):**
```bash
cd proxmox
bash scripts/make-release-tar.sh
# → release/proxmox-release-20260222-143022-a1b2c3.tar.gz
# → release/proxmox-release-20260222-143022-a1b2c3.tar.gz.sha256
```

**서버로 전송 및 설치:**
```bash
# 서버로 전송
scp release/proxmox-release-*.tar.gz user@server:/home/user/

# 서버에서 압축 해제
tar -xzf proxmox-release-*.tar.gz
cd proxmox

# 최초 설치
bash install.sh

# 또는 기존 운영 서버에 소스 반영
bash deploy.sh
```

**제외 항목** (전송되지 않음):

| 경로 | 이유 |
|---|---|
| `.env` | 비밀번호/시크릿 포함 |
| `servers/postgres/data/` | DB 데이터 |
| `servers/nginx/certs/` | 인증서 |
| `node_modules/`, `app/dist/` | 빌드 시 자동 생성 |
| `servers/app/uploads/`, `logs/` | 런타임 데이터 |

---

## 8. HTTPS(인증서 없는 경우)

원칙:
- HTTPS는 인증서가 있어야 “정상적인” TLS 통신이 됩니다.
- 인증서 없이 IP만으로 HTTPS를 강제하면 브라우저 경고/정책 문제가 생깁니다.

현재 기본 구성:
- 인증서가 없으면 HTTP(80)로 먼저 운영하고,
- 운영 도메인이 정해지고 인증서를 준비한 뒤 443을 활성화하는 흐름을 권장합니다.

관련 파일:
- `proxmox/servers/nginx/default.conf`
- `proxmox/servers/nginx/certs/` (인증서 배치 위치)
