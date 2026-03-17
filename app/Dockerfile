# 1. 빌드 스테이지
FROM node:22-alpine AS builder

# 빌드에 필요한 도구 설치 (Prisma, bcrypt 등 네이티브 모듈 대비)
RUN apk add --no-cache libc6-compat

WORKDIR /app

# 의존성 설치를 위해 패키지 파일 먼저 복사
COPY package*.json ./
COPY prisma ./prisma/

# 정밀 설치 대신 일반 설치 사용 (package-lock 미비 대비)
RUN npm install -g npm@latest && npm config set registry https://registry.npmjs.org/ && npm config set fetch-retries 5 && npm config set fetch-retry-mintimeout 20000 && npm config set fetch-retry-maxtimeout 120000 && npm config set fetch-timeout 120000 && npm install

# 소스 코드 복사
COPY . .

# Preflight checks (fail the build if an old/stale source tree is used).
# These prevent runtime 500s like: "error is not defined" on /auth/otp-setup
RUN test -f src/views/otp-setup.ejs \
  && ( \
    grep -Fq "locals && locals.error" src/views/otp-setup.ejs \
    || ( ! grep -Fq "<% if (error)" src/views/otp-setup.ejs ) \
    || ( grep -Fq "<% if (error)" src/views/otp-setup.ejs && test -f src/routes/auth.ts && grep -n -E "render\\([\"']otp-setup[\"'][^\\n]*\\{[^\\}]*\\berror\\b" src/routes/auth.ts >/dev/null 2>&1 ) \
  )

# Admin page must not crash due to TDZ (use `var IS_ENGLISH`, not const/let).
RUN test -f src/views/admin.ejs \
  && grep -Eq "^var IS_ENGLISH = " src/views/admin.ejs \
  && ! grep -Eq "^(const|let) IS_ENGLISH = " src/views/admin.ejs

# No CDN references in views (avoid tracking-prevention warnings and offline failures).
RUN ! grep -R \"cdn\\.jsdelivr\\.net\" -n src/views >/dev/null 2>&1 || (echo \"ERROR: CDN reference found in src/views\"; exit 1)

# Prisma 클라이언트 생성
RUN npx prisma generate

# TypeScript 빌드 수행
RUN npm run build

# [핵심] 빌드 후 정적 자산(EJS, CSS 등)을 dist 폴더로 강제 복사
# tsc는 .ts 파일만 처리하므로 이 과정이 없으면 뷰 파일을 찾지 못합니다.
RUN cp -r src/views dist/views || true
RUN cp -r src/public dist/public || true
# 기본 메뉴 설정 JSON 파일 복사 (Single Source of Truth)
RUN cp -r defaults dist/defaults || true
RUN if [ -f BUILD_ID ]; then cp BUILD_ID dist/BUILD_ID; fi

# Vendor assets (avoid third-party CDN warnings / tracking prevention issues)
RUN mkdir -p dist/public/vendor/flatpickr/plugins/confirmDate \
  && cp node_modules/flatpickr/dist/flatpickr.min.css dist/public/vendor/flatpickr/flatpickr.min.css \
  && cp node_modules/flatpickr/dist/flatpickr.min.js dist/public/vendor/flatpickr/flatpickr.min.js \
  && cp node_modules/flatpickr/dist/plugins/confirmDate/confirmDate.css dist/public/vendor/flatpickr/plugins/confirmDate/confirmDate.css \
  && cp node_modules/flatpickr/dist/plugins/confirmDate/confirmDate.js dist/public/vendor/flatpickr/plugins/confirmDate/confirmDate.js

# Tabler icons webfont (avoid CDN warnings)
RUN mkdir -p dist/public/vendor/tabler-icons/dist \
  && cp -r node_modules/@tabler/icons-webfont/dist/* dist/public/vendor/tabler-icons/dist/

# Chart.js (avoid CDN warnings)
RUN mkdir -p dist/public/vendor/chart.js \
  && cp node_modules/chart.js/dist/chart.umd.min.js dist/public/vendor/chart.js/chart.umd.min.js


# 2. 실행 스테이지 (경량화 및 보안)
FROM node:22-alpine AS runner

RUN apk add --no-cache libc6-compat postgresql-client
WORKDIR /app

# npm 최신 버전 업데이트 및 알림 비활성화
RUN npm install -g npm@latest && npm config set registry https://registry.npmjs.org/ && npm config set fetch-retries 5 && npm config set fetch-retry-mintimeout 20000 && npm config set fetch-retry-maxtimeout 120000 && npm config set fetch-timeout 120000 && npm install -g npm@latest && npm config set update-notifier false

# 보안을 위해 시스템 환경 변수 설정
ENV NODE_ENV=production

# 빌드 스테이지에서 필요한 결과물만 추출
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Entrypoint 스크립트 복사
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Ensure backups directory exists and is writable by the node user (UID 1000)
# This is a fallback for environments where the bind mount is not pre-created.
RUN mkdir -p /app/backups && chown node:node /app/backups

# 익명 사용자(node)로 실행하여 보안 강화
USER node

# 서버 실행
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
