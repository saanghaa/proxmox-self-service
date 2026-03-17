# 메뉴 설정 가이드

## 파일 구조

```
proxmox/
├── config/
│   ├── default-menu-config.json  ← 초기 메뉴 설정 (JSON)
│   └── README.md                 ← 이 파일
├── app/
│   └── defaults/
│       └── default-menu-config.json  ← 빌드 시 임베드된 기본값
└── docker-compose.yml            ← config 폴더 마운트됨
```

## 메뉴 초기화 동작

컨테이너 시작 시 `docker-entrypoint.sh`가 자동으로:

1. DB에 `menu_config` 없음 → `config/default-menu-config.json`에서 자동 로드
2. DB에 `menu_config` 있음 → 새 메뉴 항목 자동 병합 (기존 설정 유지)

> 수동 스크립트 실행 불필요. 컨테이너 재시작만으로 새 메뉴가 자동 반영됩니다.

## 메뉴 변경 방법

### 웹 UI (권장)

1. Admin 페이지 → **Menu Settings** 탭
2. JSON 편집기에서 수정
3. **Save Changes** 클릭
4. 브라우저 새로고침

### JSON 파일 수정 (초기 설정용)

```bash
# 1. 설정 파일 편집
vi config/default-menu-config.json

# 2. 컨테이너 재시작 (자동 병합)
docker compose restart app
```

## 사용 가능한 menu_key

### Header Menus
| menu_key | 설명 |
|----------|------|
| `DASHBOARD` | 대시보드 |
| `ADMIN_PANEL` | 관리자 패널 |
| `LOGOUT` | 로그아웃 |

### Admin Tabs
| menu_key | 설명 | sort_order |
|----------|------|------------|
| `VM_REQUESTS` | VM 생성 요청 확인 | 1 |
| `DELETED_VM_MANAGEMENT` | 삭제 예정 VM 관리 | 2 |
| `USER_MANAGEMENT` | 사용자 관리 | 3 |
| `GROUP_MANAGEMENT` | 그룹 관리 | 4 |
| `GROUP_QUOTA` | 그룹 할당량 | 5 |
| `NOTIFICATION_SETTINGS` | 알림 설정 | 6 |
| `PASSWORD_POLICY` | 보안 정책 (비밀번호 + SSH 키 교체) | 7 |
| `AUDIT_LOGS` | 감사 로그 | 8 |
| `MENU_SETTINGS` | 메뉴 설정 | 9 |
| `UI_SETTINGS` | UI 텍스트 설정 | 10 |
| `PROXMOX_CONNECTION` | PROXMOX 서버 연결 | 11 |
| `BACKUP_MANAGEMENT` | 백업 & 복구 | 12 |
| `STATISTICS` | 통계 대시보드 | 13 |

### Sidebar Menus
| menu_key | 설명 |
|----------|------|
| `CHANGE_PASSWORD` | 비밀번호 변경 |

> `menu_key`는 코드와 연결되어 있으므로 변경하면 안 됩니다.

## 필드 설명

### 변경 가능
- **display_name**: 표시 이름 (한글/영어 자유)
- **icon**: 아이콘 (이모지, HTML)
- **sort_order**: 정렬 순서
- **is_visible**: 표시 여부

### 변경 금지
- **uuid**: 고유 식별자
- **menu_key**: 코드 연결용 키

## 트러블슈팅

### 메뉴가 표시되지 않음
```bash
# DB 확인
docker compose exec postgres psql -U proxmox -d proxmox -c \
  "SELECT key, LENGTH(value) FROM \"SystemConfig\" WHERE key = 'menu_config';"

# 브라우저 캐시 삭제 후 강력 새로고침 (Ctrl+Shift+R)
```

### 새 메뉴가 자동 추가 안됨
```bash
# 컨테이너 재시작 (자동 병합 트리거)
docker compose restart app

# 로그 확인
docker logs proxmox-app --tail=30
```
