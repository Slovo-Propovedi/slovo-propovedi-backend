# AGENTS.md

Backend API guide for agents working in this repository: the **Слово.Проповеди NestJS backend API** —
a NestJS + TypeORM + PostgreSQL + MinIO service. This repo is the standalone backend, split from the
former `slovo-propovedi-admin` monorepo; its former path `backend/` is now the repo root.

## Read the knowledge base first

- Start with `docs/README.md` and `docs/architecture.md` before touching the application bootstrap or
  environment handling.
- Read the relevant `docs/modules/<module>.md` document before implementing or changing a module
  (auth, users, sermons, playlists, sections, minio, app/files, health).
- Update the affected `docs/**` in the same commit as the code change.
- Record any TODO/hack in the same commit (see `docs/README.md` for the debt-document convention).

**Centralized verification:** full runs are NEVER part of an implementation task and NEVER run in parallel with each other. Agents working on delegated tasks must NOT run project-wide checks on their own (`npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`). During implementation an agent runs only targeted, file-scoped checks: a single test file (`npm test -- <single test path>`) or lint limited to the files it edited.

The full verification pass runs ONCE as a SEPARATE dedicated task, AFTER all implementation tasks are finished: the orchestrator delegates it as a single task and routes any failures back to the responsible agent. Full runs are never executed concurrently — two concurrent full runs hang the machine (laptop freeze). This holds in single-agent and multi-agent sessions alike.

## Mandatory Workflows: SDD, Plan-Implement, TDD

Every non-trivial task runs through a workflow BEFORE implementation. Workflow skills live in `.opencode/skills/<name>/SKILL.md` with a byte-identical mirror in `.claude/skills/` (keep both copies in sync). Spec-driven commands live in `.opencode/commands/speckit.*.md` (mirrored in `.claude/commands/`).

| Situation | Workflow | How |
|-----------|----------|-----|
| New feature, API contract change, cross-cutting change, vague requirements | Spec-Driven Development | `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.taskstoissues` (mirror tasks to the Forgejo board; needs `FORGEJO_TOKEN`) → `/speckit.implement` (`/speckit.constitution` once per repo; `/speckit.analyze` / `/speckit.checklist` when useful) |
| Clear requirements, multi-step change (no spec needed) | Plan → implement | `plan-implement` skill |
| Any bug, red test, unexpected behavior | Debug first | `systematic-debugging` skill |
| Any code/behavior change (inside any workflow) | Test-Driven Development | `tdd` skill (verification-first Mode B when no test runner) |
| Pure refactor (no behavior change) | TDD, suite stays green | `tdd` skill — add a characterization test first if coverage is missing |
| Docs-only change | Verification-first | `tdd` skill Mode B (lint/build/link check as the failing check) |
| Generated code (`api:generate`, prebuild, dependency bumps) | Exempt from the Iron Law | Run the generator, review the diff, run the full verification suite |
| Always, on every task | Minimal diff | `ponytail` skill |
| Before claiming ANY task done | Done-gate | `verification-before-completion` skill |

Rules:

1. Load the workflow skill via the `skill` tool BEFORE writing code and announce it ("Using <skill> to <purpose>"). Spec-level features start with the `/speckit.*` commands instead.
2. No production code without a failing check first (`tdd` Iron Law).
3. Specs, plans and task lists are repo artifacts: spec-kit features live under `specs/<NNN-slug>/`; commit them together with the implementation.
4. Opt-out only when the user explicitly says so ("skip workflow", "just do it") — and name the skip in the completion report.
5. Verification commands for this repo: `npm run lint`, `npm test`, `npm run build` (e2e: `npm run test:e2e`), `bash .opencode/tools/check-skills-sync.sh`.
6. A shortcut with a known limit gets a `shortcut: <what was skipped>, <when to revisit>` comment AND a `docs/debt.md` entry (where the repo keeps a debt ledger).

The `specify` CLI is NOT required at runtime — it is a scaffolder used only to (re)generate `.specify/` templates and the speckit commands. Contributors need only OpenCode/Claude Code + bash.

**Template maintenance (maintainer-only):** refreshing the spec-kit scaffolding (`.specify/` + `speckit.*` commands) to a new spec-kit release is a periodic task for the designated template maintainer — never a routine contributor or agent task. The canonical copy of the workflow skills, speckit commands and this scaffolding lives in **slovo-propovedi-mobile**: make changes there first, verify with `bash .opencode/tools/check-skills-sync.sh`, then propagate copies to the other repos and re-run the check in each. When editing a workflow skill, edit the mobile copy first and re-propagate.

## Documentation rules

Documentation lives in `docs/` and is written in **Russian** (the AGENTS.md and the root README.md are
the exceptions — they are in English).

- Every backend module is documented in `docs/modules/<name>.md` — one document per module plus
  `docs/modules/README.md` as the index.
- The REST contract and the codegen pipeline are documented in `docs/contracts/rest-api.md`; the spec
  itself is external, in the `slovo-propovedi-docs` repo (published at
  `https://docs.slovo-propovedi.ru/openAPI.yaml`).
- The DB schema is in `docs/db.md`; the validation pipeline in `docs/validation-pipeline.md`.
- **Source of truth = validation schemas.** The API contract is defined by the generated zod schemas
  (`src/generated/index.ts`) exposed via `createZodDto` DTOs, not by prose docs. Docs describe; schemas
  decide. Never trust a doc field list over the schema. OpenAPI version is not pinned in docs — see
  `info.version` in the external `openAPI.yaml`.
- **Update docs in the same PR as the code change.** A code change without a docs update is incomplete.
- **Tech debt: fix new debt immediately instead of recording it.** When a debt item is resolved,
  **delete** its entry from `docs/debt.md` — the file lists **open** debts only; resolved entries are
  removed, not archived.
- **Don't pin package versions in docs** — they go stale. Use a minimal bound (bare major like
  `typescript@6`, or "not above major X") where a version is essential. Historical/spec anchors
  (OpenAPI spec versions, release tags, commit hashes) are exempt.

## Stack & conventions

- **NestJS**, **TypeORM** (`synchronize: false`), **PostgreSQL**, **MinIO**.
- **Build & test toolchain:** the production build runs the native TypeScript compiler (`tsgo`,
  `@typescript/native-preview`) plus `tsc-alias` — not `nest build`; `typescript@6` stays installed for
  ESLint and `nest start`. Unit tests run on Jest with the `@swc/jest` transform (no `ts-jest`).
- **Validation via `nestjs-zod`**: `createZodDto(...)` for every request DTO, `@ZodResponse` for
  responses, strict `zod.strictObject` at the boundary. `strictSchemaDeclaration: true` requires every
  route parameter to be a Zod DTO.
- **Passwords via `bcrypt`** (10 rounds). **Auth via JWT** — own `AuthGuard`, payload `{ id, email }`;
  no Passport. No global auth guard — protection is per-route. The only global guard is
  `ThrottlerGuard` (rate limiting; see `docs/modules/auth.md`).
- **Parse, don't validate** at the boundary: `@nestjs/zod` rejects unknown keys; generated schemas are
  the single source of truth, extended/overridden with `.extend(...)` where needed (never rewritten).
- **Generated code is a contract.** `src/generated/index.ts` is **never hand-edited** — only
  regenerated.

## OpenAPI-first codegen

- The API contract lives in the **external** `slovo-propovedi-docs` repo and is published at
  `https://docs.slovo-propovedi.ru/openAPI.yaml`. There is no OpenAPI file in this repo.
- After the spec changes, run `npm run gen:schemas` (Orval → `src/generated/index.ts`) and commit the
  regenerated schemas together with the code.
- The frontend SDK is generated separately in the `slovo-propovedi-admin` repo.

## DDL

- Schema changes only via SQL files: `sql/bootstrap.sql` (fresh DB) plus manual migrations under
  `sql/` (e.g. `sql/migrate-add-username.sql`, `sql/migrations/001_add_positions.sql`).
- Never use ORM `synchronize` for schema changes (`synchronize: false`). Migrations are applied
  manually via `psql` and are idempotent.

## Quality gates

- `npm run test` — unit tests (Jest, `@swc/jest` transform).
- `npm run build` — native TypeScript build (`tsgo` + `tsc-alias`), not `nest build`.
- `npm run lint` — eslint.

## Deployment

- Deploy is tag-driven: push a `v*` tag → Forgejo Actions builds the Docker image and deploys to the VPS.
- Commits follow Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`).
