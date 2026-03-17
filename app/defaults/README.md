# UUID 기반 UI 라벨 시스템

## 개요

하드코딩 없이 모든 UI 요소(메뉴, 버튼, 테이블 헤더, 라벨)를 UUID로 관리하고, 다국어를 쉽게 지원하는 시스템입니다.

## 파일 구조

```
app/defaults/
├── ui-elements.json        # 모든 UI 요소의 UUID 정의 (Single Source of Truth)
└── labels/
    ├── ko.json             # 한국어 라벨 (UUID → 텍스트 매핑)
    └── en.json             # 영어 라벨 (UUID → 텍스트 매핑)
```

## 설계 원칙

### 1. 완전 분리 (Complete Separation)
- **UI 요소**: `ui-elements.json`에서 UUID, 액션, CSS 클래스 등 정의
- **텍스트 라벨**: `labels/{lang}.json`에서 `button_key` → 텍스트 매핑

### 2. Single Source of Truth
- 모든 UI 요소는 `ui-elements.json`에서만 정의
- 각 언어의 텍스트는 해당 언어 파일에서만 정의

### 3. 하드코딩 제거
- 코드에 표시 텍스트 없음
- 모든 텍스트는 `button_key` (또는 UUID)로 참조

## 사용법

### 1. 새로운 버튼 추가

#### Step 1: `ui-elements.json`에 버튼 정의 추가
```json
{
  "buttons": {
    "user_management": [
      {
        "uuid": "btn-new-unique-uuid-here",
        "button_key": "NEW_BUTTON",
        "action": "myAction",
        "css_class": "btn btn-primary",
        "sort_order": 10,
        "is_visible": true
      }
    ]
  }
}
```

#### Step 2: 각 언어 파일에 라벨 추가

**labels/ko.json**:
```json
{
  "buttons": {
    "NEW_BUTTON": "내 버튼"
  }
}
```

**labels/en.json**:
```json
{
  "buttons": {
    "btn-new-unique-uuid-here": "My Button"
  }
}
```

### 2. 새로운 테이블 헤더 추가

#### Step 1: `ui-elements.json`에 헤더 정의 추가
```json
{
  "table_headers": {
    "user_management": [
      {
        "uuid": "hdr-new-unique-uuid-here",
        "header_key": "NEW_COLUMN",
        "data_field": "newField",
        "sortable": true,
        "sort_order": 8,
        "is_visible": true
      }
    ]
  }
}
```

#### Step 2: 각 언어 파일에 라벨 추가

**labels/ko.json**:
```json
{
  "table_headers": {
    "hdr-new-unique-uuid-here": "새 컬럼"
  }
}
```

**labels/en.json**:
```json
{
  "table_headers": {
    "hdr-new-unique-uuid-here": "New Column"
  }
}
```

### 3. TypeScript에서 사용

```typescript
import { getButtons, getTableHeaders, getAllLabels } from '../utils/labelLoader';

// 버튼 가져오기 (한국어)
const buttons = getButtons('user_management', 'ko');

// 테이블 헤더 가져오기 (영어)
const headers = getTableHeaders('user_management', 'en');

// 모든 라벨 가져오기
const labels = getAllLabels('ko');
console.log(labels.messages.success_user_created); // "사용자가 생성되었습니다"
```

### 4. EJS 템플릿에서 사용

```html
<!-- 버튼 렌더링 -->
<%
const buttons = sectionLabels?.admin?.user_management?.buttons || [];
buttons.forEach(btn => {
  if (btn.is_visible) {
%>
  <button class="<%= btn.css_class %>" onclick="<%= btn.action %>()">
    <%= btn.display_name %>
  </button>
<%
  }
});
%>

<!-- 테이블 헤더 렌더링 -->
<thead>
  <tr>
    <%
    const headers = sectionLabels?.admin?.user_management?.table_headers || [];
    headers
      .filter(h => h.is_visible)
      .sort((a, b) => a.sort_order - b.sort_order)
      .forEach(header => {
    %>
      <th <%= header.sortable ? 'class="sortable"' : '' %>>
        <%= header.display_name %>
      </th>
    <% }); %>
  </tr>
</thead>
```

## UUID 생성 가이드

### UUID 패턴
```
{타입}-{섹션UUID 기반}-{순번}

예시:
- btn-550e8400-e29b-41d4-a716-446655440001  (버튼)
- hdr-550e8400-e29b-41d4-a716-446655440101  (헤더)
- sec-550e8400-e29b-41d4-a716-446655440001  (섹션)
```

### 타입 접두사
- `btn-`: 버튼
- `hdr-`: 테이블 헤더
- `sec-`: 섹션

### UUID 생성 도구
```bash
# Linux/macOS
uuidgen

# Node.js
node -e "console.log(require('crypto').randomUUID())"

# Online
https://www.uuidgenerator.net/
```

## 섹션별 구조

### User Management
- **버튼**: EXPORT_CSV, ADD_USER, ENABLE_ADMIN, CHANGE_GROUP, PW_RESET, OTP_RESET, ACTIVATE, DEACTIVATE, DELETE
- **헤더**: EMAIL, STATUS, ADMIN, OTP, GROUPS, CREATED, ACTIONS

### Group Management
- **버튼**: EXPORT_CSV, ADD_GROUP, ADD_MEMBER, EDIT, REMOVE, DELETE_GROUP
- **헤더**: GROUP_NAME, MEMBERS, CREATED, ACTIONS

### VM Management
- **버튼**: EXPORT_CSV, RESTORE, DELETE
- **헤더**: VMID, HOSTNAME, IP_ADDRESS, GROUP, JOB_ID, STATUS, CREATED, ACTIONS

### Dashboard
- **버튼**: EXPORT_MY_VMS, ADD_EXISTING_VM, DOWNLOAD_KEY, ASSIGN_JOB, DELETE_VM
- **헤더**: VMID, HOSTNAME, IP_ADDRESS, JOB_ID, GROUP, CREATED, SSH_KEY, ACTIONS

## 언어 추가

새로운 언어를 추가하려면:

### 1. 라벨 파일 생성
```bash
cp labels/ko.json labels/ja.json  # 일본어 예시
```

### 2. `labelLoader.ts`에 언어 타입 추가
```typescript
export type SupportedLanguage = 'ko' | 'en' | 'ja';
```

### 3. 라벨 번역
`labels/ja.json` 파일을 일본어로 번역

### 4. 미들웨어 업데이트 (선택사항)
사용자 선호 언어 감지 로직 추가

## 마이그레이션 가이드

기존 하드코딩된 코드를 UUID 기반으로 마이그레이션:

### Before (하드코딩)
```html
<button onclick="exportUsers()">📥 Export CSV</button>
```

### After (UUID 기반)
```html
<%
const exportBtn = sectionLabels?.admin?.user_management?.buttons
  .find(b => b.button_key === 'EXPORT_CSV' && b.is_visible);
%>
<% if (exportBtn) { %>
  <button class="<%= exportBtn.css_class %>"
          style="<%= exportBtn.style || '' %>"
          onclick="<%= exportBtn.action %>()">
    <%= exportBtn.display_name %>
  </button>
<% } %>
```

## 캐싱

라벨 로더는 자동으로 메모리 캐싱을 수행합니다:

```typescript
import { clearCache } from '../utils/labelLoader';

// 개발 환경에서 변경사항 반영 시
clearCache();
```

## 디버깅

### 1. 로딩 확인
```typescript
import { loadUIElements, loadLabels } from '../utils/labelLoader';

const elements = loadUIElements();
console.log('UI Elements:', elements);

const labels = loadLabels('ko');
console.log('Korean Labels:', labels);
```

### 2. 병합된 설정 확인
```typescript
import { getUIConfig } from '../utils/labelLoader';

const config = getUIConfig('ko');
console.log('Merged Config:', config);
```

### 3. 특정 섹션 확인
```typescript
import { getSection } from '../utils/labelLoader';

const userMgmt = getSection('admin', 'user_management', 'ko');
console.log('User Management Section:', userMgmt);
```

## 모범 사례

### ✅ DO
- 모든 새 UI 요소는 UUID로 정의
- 의미있는 `button_key`, `header_key` 사용
- `sort_order`로 표시 순서 제어
- `is_visible`로 동적 표시/숨김 제어
- 모든 언어 파일을 동기화

### ❌ DON'T
- 코드에 직접 텍스트 하드코딩
- UUID를 직접 생성하지 말고 생성기 사용
- `display_name`을 `ui-elements.json`에 포함
- 일부 언어 파일만 업데이트

## 문제 해결

### 문제: 라벨이 표시되지 않음
**해결**:
1. UUID가 정확한지 확인
2. 언어 파일에 해당 UUID 존재 확인
3. 캐시 클리어 후 재시도

### 문제: 잘못된 언어가 표시됨
**해결**:
1. `Accept-Language` 헤더 확인
2. 미들웨어의 언어 감지 로직 확인
3. 기본값 확인 (`ko`)

### 문제: 버튼/헤더 순서가 잘못됨
**해결**:
`sort_order` 값을 확인하고 조정

## API 레퍼런스

### labelLoader.ts

#### `loadUIElements(): UIElements`
UI 요소 정의를 로드합니다.

#### `loadLabels(lang: SupportedLanguage): Labels`
특정 언어의 라벨을 로드합니다.

#### `getUIConfig(lang: SupportedLanguage): UIConfig`
UI 요소와 라벨을 병합한 설정을 반환합니다.

#### `getButtons(section: string, lang?: SupportedLanguage): MergedButton[]`
특정 섹션의 버튼 목록을 반환합니다.

#### `getTableHeaders(section: string, lang?: SupportedLanguage): MergedTableHeader[]`
특정 섹션의 테이블 헤더 목록을 반환합니다.

#### `getSection(page: string, section: string, lang?: SupportedLanguage): MergedSection | null`
특정 섹션 정보를 반환합니다.

#### `getAllLabels(lang?: SupportedLanguage): Labels`
모든 라벨을 반환합니다 (클라이언트 사이드 사용).

#### `clearCache(): void`
캐시를 초기화합니다.

#### `toLegacyFormat(lang?: SupportedLanguage): any`
기존 형식으로 변환합니다 (하위 호환성).

## 기여하기

새로운 UI 요소나 라벨을 추가할 때:

1. `ui-elements.json`에 UUID 정의 추가
2. **모든** 언어 파일에 번역 추가
3. 타입 정의 업데이트 (필요시)
4. 테스트 확인
5. Pull Request 제출

## 라이센스

이 프로젝트의 일부입니다.
