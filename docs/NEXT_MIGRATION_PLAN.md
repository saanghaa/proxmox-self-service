# Proxmox Next.js Migration Plan (v1)

## 1. Objective

- Migrate UI from `Express + EJS` to `Next.js (App Router)` incrementally.
- Keep service stable during migration (no big-bang rewrite).
- Improve maintainability, component reuse, and release safety.

Design motto:
- Build a bold, visually rich interface with strong data visualization and meaningful animation.
- Avoid generic UI; prioritize distinctive visual identity and polished motion.

## 2. As-Is

- UI: `app/src/views/*.ejs`
- Server: Express routes (`routes/ui.ts`, `routes/api/*.ts`, `auth.ts`)
- Data: Prisma + PostgreSQL
- Session: Redis
- Infra: Docker Compose + Nginx

## 3. To-Be

- Frontend: Next.js 15+ (App Router, TypeScript)
- Style: shared design tokens + reusable component system
- API strategy:
  - Stage 1: reuse existing Express APIs
  - Stage 2: selectively move to Next Route Handlers/Server Actions
- Routing: Nginx path-based progressive switch

## 4. Migration Principles

1. No big-bang, use strangler pattern.
2. Migrate UI first, keep domain logic stable.
3. Verify feature parity before traffic switch.
4. Keep rollback path available at every phase.
5. Prioritize behavior parity over new features.
6. For frontend redesign, prioritize visual impact and animation quality.

## 5. Phase Plan

### Phase 0. Foundation (1 week)

- Bootstrap `frontend-next/`
- TS/ESLint/Prettier/CI build setup
- Global tokens (color/spacing/typography)
- Nginx routing draft (`/next/*`)

Deliverables:
- Next app skeleton + passing CI build
- Initial deploy pipeline

### Phase 1. Auth Screens (1-2 weeks)

Scope:
- Login / Register / Forgot Password / Change Password / OTP screens

Approach:
- Reuse existing `/auth/*`, `/api/language`
- Match UX parity (theme, language, autofill, toggle behavior)

Exit criteria:
- Auth E2E flows pass
- No UI regressions on core browsers

### Phase 2. Dashboard Read-Only (2 weeks)

Scope:
- VM list/read-only dashboard sections

Approach:
- Keep existing `/api/*` contracts
- Split monolithic client scripts into components

Exit criteria:
- Data parity with existing EJS view
- Improved initial render/screen transition metrics

### Phase 3. Admin Read-Only (2-3 weeks)

Scope:
- Stats/inventory/log read screens from `admin.ejs`

Approach:
- Componentize accordion/cards/charts
- Use server components where possible

Exit criteria:
- Feature parity for read operations
- Interaction bugs reduced (expand/collapse consistency)

### Phase 4. Admin Write Ops (2-3 weeks)

Scope:
- Approve/reject requests, backup/restore UI, node/settings updates

Approach:
- Reuse existing Express APIs initially
- Add strict confirmation + guardrails for destructive ops

Exit criteria:
- Full admin workflows usable in Next UI
- Audit log / notification behavior unchanged

### Phase 5. Traffic Cutover & Cleanup (1-2 weeks)

- Nginx default route switch to Next
- Keep fallback route to legacy EJS during stabilization
- Remove legacy UI paths after stable run window

Exit criteria:
- 1+ week stable production run
- No critical incidents

## 6. Timeline

- Total estimate: 9-13 weeks
- Phase 0-1: 2-3 weeks
- Phase 2-3: 4-5 weeks
- Phase 4-5: 3-5 weeks

## 7. QA Strategy

- Automated:
  - E2E for auth, dashboard, admin critical paths
  - API contract smoke checks
- Manual:
  - Theme/language/autofill cross-browser checks
  - Backup/restore/request-approval flows
- Parity checklist:
  - Legacy EJS vs Next screenshots + behavior checkpoints

## 8. Risks & Mitigation

- Session/auth mismatch:
  - Keep existing session strategy first, avoid auth rewrite early.
- Admin regression risk:
  - Migrate by feature slices with feature flags.
- High-risk ops (backup/restore):
  - Require staging rehearsal and explicit confirmation UX.
- Schedule overrun:
  - Freeze scope to UI migration first; postpone API refactor.

## 9. Rollback Plan

- Nginx route fallback: Next -> legacy EJS
- Keep DB/schema changes minimal in early phases
- Feature flags for screen-level rollback

## 10. Execution Checklist

| Item | Owner | Status | Notes |
|---|---|---|---|
| Create `frontend-next/` with TS + App Router |  | TODO |  |
| Configure lint/format/build CI |  | TODO |  |
| Define design tokens and base layout |  | TODO |  |
| Add Nginx route for Next preview path |  | TODO |  |
| Migrate login screen |  | TODO |  |
| Migrate register screen |  | TODO |  |
| Migrate forgot/change password screens |  | TODO |  |
| Migrate OTP flows |  | TODO |  |
| Auth E2E parity tests |  | TODO |  |
| Migrate dashboard read-only sections |  | TODO |  |
| Migrate admin stats/inventory read views |  | TODO |  |
| Migrate admin write operations |  | TODO |  |
| Staging rehearsal for backup/restore ops |  | TODO |  |
| Traffic cutover plan + rollback drill |  | TODO |  |
| Production cutover and stabilization window |  | TODO |  |
