# REST API — общая спецификация и кодогенерация

> **Источник истины контракта — схемы валидации** (`src/generated/index.ts`, zod DTO). Эта страница описывает контракт и конвейер кодогенерации, но при расхождении между текстом и схемой решает **схема**. Актуальная версия спецификации в документации не поддерживается — см. `info.version` внешнего `openAPI.yaml` (репозиторий `slovo-propovedi-docs`); единичные исторические якоря помечены явно.

Внешний контракт REST API платформы «Слово.Проповеди». **Подробный список эндпоинтов и типов — в сгенерированных файлах** (`src/generated/index.ts`); этот документ не дублирует их, а фиксирует **общую спецификацию**, **конвейер кодогенерации** и **карту реализации** эндпоинтов sermons/playlists/users в контроллерах.

**Статус:** актуально
**Слой:** contracts (внешний протокол)

## Общая спецификация

- **URL:** `https://docs.slovo-propovedi.ru/openAPI.yaml`
- **Название:** «API — Слово.Проповеди» (версия — в `info.version` самого файла)
- **Где живёт:** во **внешнем swagger-репозитории** `slovo-propovedi-docs`, НЕ в этом репозитории. `/openAPI.yaml` здесь gitignored и локально отсутствует.
- **Публикация:** спецификация деплоится из `slovo-propovedi-docs` через Forgejo на тегах `v*` (`https://docs.slovo-propovedi.ru/openAPI.yaml`).
- **Опубликованная версия (исторический якорь):** на момент миграций 013–015 (`created_at` + uuidv7) опубликована спецификация **0.23.0** — в ней уже есть `createdAt` в ответах sermon/playlist и описание составного курсора. Актуальный номер всегда в `info.version`; здесь он зафиксирован только как якорь изменения.
- **Потребляется:** кодогенерацией Orval (фронтенд-SDK — в репозитории `slovo-propovedi-admin`), конфиг которой хардкодит этот URL как `input`.

## Конвейер кодогенерации

### Orval (zod-схемы)

| Параметр | Значение |
|----------|----------|
| Конфиг | `orval.config.mjs` |
| Ключ проекта | `backend-schemas` |
| `input` | `https://docs.slovo-propovedi.ru/openAPI.yaml` |
| `output` | `src/generated/index.ts` |
| `client` | `zod` (`variant: 'full'`, `version: 4`) |
| `strict` | все контексты `true` (param/query/header/body/response) |
| Команда | `npm run gen:schemas` |
| Реализация | `scripts/gen-schemas.mjs` — вызывает orval программно, затем prettier по выходному файлу |

> ✅ `strict: true` для zod требует **per-context** ключей (Orval молча нормализует простой `strict: true` в all-false) — см. комментарий в `orval.config.mjs`. Результат: каждая zod-схема на границе отбраковывает лишние ключи.

`gen:schemas` = `node scripts/gen-schemas.mjs`. Выходные схемы используются в `@ZodResponse()` и DTO контроллеров (`src/sermon/`, `src/playlist/`).

**Локальная спецификация.** Если правка контракта ещё не опубликована на `docs.slovo-propovedi.ru`, кодогенерацию можно запустить против локального файла: `OPENAPI_SPEC_PATH=/путь/к/slovo-propovedi-docs/openAPI.yaml npm run gen:schemas`. Переменная переопределяет `input` в `orval.config.mjs` и делает `DOCS_HOSTNAME` необязательной; без неё кодогенерация идёт по опубликованному URL (сейчас 0.23.0). Это временный инструмент: после публикации правки переменную из `.env` удаляют.

### При изменении спецификации

При изменении спецификации схемы регенерируются в этом репозитории (`npm run gen:schemas`); фронтенд-SDK регенерируется отдельно в своём репозитории (`slovo-propovedi-admin`). Сгенерированные файлы коммитятся вместе с кодом.

> ⚠️ **Порядок выката при удалении эндпоинтов.** Если из спецификации удалён маршрут, SDK админки (`slovo-propovedi-admin`) может продолжать его вызывать. Сначала регенерируется и обновляется фронтенд, затем деплоится backend-релиз — иначе UI получит `404`.

## Ограничения входных payload'ов

Все ограничения размера (строки, массивы, страницы) заданы **только на входных схемах** — request body и query/path-параметрах. **Response-схемы намеренно не ограничиваются**: в БД могут лежать legacy-строки, не проходящие новые лимиты, и `maxLength`/`maxItems` в ответе превратил бы публичное чтение в `500` при сериализации. Принцип: **граница парсит вход, но не переписывает исторические данные**.

| Поле (вход) | Ограничение | Причина |
|-------------|-------------|---------|
| `password` (create-user, change-password) | `minLength: 8`, `maxLength: 200` | Минимальная стойкость нового пароля; потолок для bcrypt |
| `SignInRequestDto.password` | `maxLength: 200`, **без** `minLength` | Legacy-пароли не блокируются на входе; потолок — защита от CPU-waste хеширования |
| `SignInRequestDto.username` | `maxLength: 100` | Потолок строки на публичном login |
| `name` | `maxLength: 100` | Разумный размер имени |
| `username` | `maxLength: 50` | Компактный логин |
| `email` | `maxLength: 254` | RFC 5321 |
| `title` (sermon/playlist/section, feature-flag) | `maxLength: 300` (feature-flag — 200) | Длиннее реальных заголовков не бывает |
| `description` (sermon/playlist/section) | `maxLength: 10000` | Long-form контент |
| `artist` | `maxLength: 200` | Имя автора/проповедника |
| `book` | `maxLength: 100` | Название книги/главы |
| `artwork` (sermon/playlist create/update) | `maxLength: 2048`, `pattern: ^(https?://.*)?$` | URL обложки или пустая строка; `javascript:`/`data:` отклоняются (stored XSS) |
| `textFileUrl`, `audioUrl` | `format: uri`, `maxLength: 2048`, `pattern: ^https?://[^/]+/files/.+$`, nullable | URL собственного хранилища: любой https?://host, но путь начинается с `/files/` (bucket). Host **не** закреплён — переживает смену `MINIO_PUBLIC_URI` |
| `youtubeUrl` | `format: uri`, `maxLength: 2048`, `pattern: ^https?://.+$`, nullable | Внешняя ссылка, без требования `/files/`; только http(s) — `z.url()` сам по себе пропускает `javascript:`/`data:` |
| `urls[]` (invidious replace) | `maxItems: 100`, элемент `maxLength: 2048` | Список инстансов; каждый адрес — строка |
| `playlistsIds`, `sermonsIds`, `sectionsIds`, `ids`, `sermonIds`, `playlistIds` | `maxItems: 1000` | Потолок массовых reorder/bulk-операций |
| `search` (sermons/playlists) | `minLength: 1`, `maxLength: 200` | Потолок входа в FTS/tsquery (дополнительно — кап 40 токенов в сервисе) |
| `page` (sermons/playlists/users) | `minimum: 1`, `maximum: 100000` | OFFSET-пагинация: защита от гигантского `OFFSET` |
| `limit`, `take` | максимум 100 | Уже существовало |
| `itemsRows` (section create/update) | `integer`, `minimum: 0`, `maximum: 100` | Колонка `integer`; исключает дробные значения (было `number`) |

Паттерн `audioUrl`/`textFileUrl` повторяет приёмку `MinioService.extractFileNameFromUrl`: путь обязан начинаться с сегмента `files` (bucket). Регэксп намеренно не фиксирует конкретный домен: сохранённые URL должны продолжать валидироваться после смены публичного адреса MinIO.

## Карта реализации эндпоинтов (sermons + playlists + users + files + feature-flags)

Ниже — эндпоинты, реализованные в контроллерах. **Чтения контента публичны** (без аутентификации — доступны и роли `user`, и анонимам): `findAll`/`findOne` у sermons/sections/playlists и файловая выдача по имени (`GET /files/:fileName`). **Write-эндпоинты** (`POST|PATCH|DELETE` контента), `GET /files` (инвентарь хранилища), orphans-роуты (`GET /files/orphans`, `POST /files/orphans/cleanup`) и `DELETE /files/:fileName` используют `AuthGuard` + `RolesGuard` (`src/auth/guard/roles.guard.ts`) с `@Roles(...)` — доступ только admin/moderator. **У users — все 6 эндпоинтов под `RolesGuard` (admin-only, нет публичных чтений).** **У feature-flags управление — admin-only, а `GET /feature-flags/me` — с опциональной аутентификацией (`OptionalAuthGuard`)**: валидный токен → эффективные флаги пользователя; без токена — глобальные состояния (`200`); невалидный/просроченный токен → `401` (клиент обновит токен и повторит запрос). Методы контроллера — из `src/sermon/sermon.controller.ts`, `src/playlist/playlist.controller.ts`, `src/section/section.controller.ts`, `src/users/users.controller.ts`, `src/invidious-instances/invidious-instances.controller.ts`, `src/feature-flags/feature-flags.controller.ts`, `src/app.controller.ts`; методы сервиса — см. модульные документы.

### Матрица доступа по ролям

| Роль | Публичные чтения | Контент (sermons/sections/playlists + `POST|PATCH|DELETE`) | Файлы (`POST /files`, `GET /files`) | Users (`/users*`) | Invidious (`/invidious-instances*`) | Feature flags (`/feature-flags*`) |
|------|------------------|--------------------------------------------------------------|--------------------------------------|-------------------|-------------------------------------|------------------------------------|
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `moderator` | ✅ | ✅ | ✅ | ❌ `403` | ❌ `403` | ✅ `/me`, ❌ `403` (управление) |
| `user` | ✅ | ❌ `403` | ❌ `403` | ❌ `403` | ❌ `403` | ✅ `/me`, ❌ `403` (управление) |
| аноним | ✅ | ❌ `401` (guarded) | ❌ `401` | ❌ `401` | ❌ `401` | ✅ `/me` (глобальные состояния), ❌ `401` (управление) |

**Публичные маршруты** (без guard'ов): `GET /sermons`, `GET /sermons/distinct-values`, `GET /sermons/:id`, `GET /playlists`, `GET /playlists/:id`, `GET /section`, `GET /section/:id`, `GET /files/:fileName`, `GET /health`, `POST /auth/login`, `POST /auth/refresh`. `GET /feature-flags/me` — с **опциональной** аутентификацией (`OptionalAuthGuard`: валидный токен → флаги пользователя; без токена → глобальные состояния; невалидный/просроченный токен → `401`). `GET /auth/profile`, `POST /auth/logout` — `AuthGuard` без `@Roles` (любой аутентифицированный).

### Sermons

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `GET /sermons` | публичный | `SermonController.findAll` | `SermonService.findAll(take, cursor, search, page, limit, sort, order)` |
| `GET /sermons/distinct-values` | публичный | `SermonController.getDistinctValues` | `SermonService.getDistinctValues` |
| `GET /sermons/:id` | публичный | `SermonController.findOne` | `SermonService.findOne` |
| `POST /sermons` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SermonController.create` | `SermonService.create` |
| `PATCH /sermons/:id` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SermonController.update` | `SermonService.update` |
| `DELETE /sermons/:id` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SermonController.remove` | `SermonService.remove` |

> ✅ `GET /sermons` принимает query `take`, `cursor` (keyset-пагинация; непрозрачный составной курсор: `{rank, id}` при `search`, `{createdAt, id}` при сортировке по дате; курсоры старого формата — голый uuid — отклоняются с `400`), `search` (опциональный, min 1 символ, полнотекстовый поиск по `title`/`artist`/`book`/`description` через tsvector FTS с `ts_rank`-ранжированием), `page`/`limit` (offset-пагинация, `limit` max 100) и `sort`/`order` (сортировка; `sort` ∈ {`date`,`title`,`artist`,`playlist`}, направленные дефолты `date`→`desc` и алфавитные→`asc`). `sort=date` упорядочивает по `date_trunc('milliseconds', created_at)` (tiebreak — `id` в том же направлении), поэтому ответы sermon/playlist содержат `createdAt` (ISO `date-time`). `page`/`limit` **взаимоисключительны** с `take`/`cursor` (одновременное использование → `400`); `sort`/`order` **взаимоисключительны** с `take`/`cursor` (→ `400`); в offset-режиме `count` — общее число совпадений, `nextCursor: null`. Поиск применён во всех путях `findAll` и игнорирует `sort`/`order` (порядок по релевантности); без `take`/`search`/`page`/`limit` отвечает полной выборкой. Подробности поиска и сортировки — [`../modules/sermon.md`](../modules/sermon.md).

### Playlists

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `POST /playlists` | `AuthGuard` + `RolesGuard` (admin, moderator) | `PlaylistController.create` | `PlaylistService.create` |
| `GET /playlists` | публичный | `PlaylistController.findAll` | `PlaylistService.findAll(search, page, limit, sort, order)` |
| `GET /playlists/:id` | публичный | `PlaylistController.findOne` | `PlaylistService.findOne` |
| `PATCH /playlists/:id` | `AuthGuard` + `RolesGuard` (admin, moderator) | `PlaylistController.update` | `PlaylistService.update` (bulk-replace состава) |
| `PATCH /playlists/:id/sermons/reorder` | `AuthGuard` + `RolesGuard` (admin, moderator) | `PlaylistController.reorderSermons` | `PlaylistService.reorderSermonsInPlaylist(id, sermonIds)` |
| `DELETE /playlists/:id` | `AuthGuard` + `RolesGuard` (admin, moderator) | `PlaylistController.remove` | `PlaylistService.remove` |

> ✅ `POST /playlists` body: `{ title, description, artwork, sermonsIds?, sectionsIds? }`. `sectionsIds?` (добавлен в v0.8.0) прикрепляет плейлист к разделам — позиция в каждом разделе = `max(position) + 1`; отсутствующий/пустой массив — no-op. Ошибки: дубликаты в `sectionsIds` → `400 Bad Request` (`Duplicate section IDs detected`); несуществующий id раздела → `404 Not Found` (`Some sections not found`). Валидация выполняется в транзакции create — при ошибке плейлист не создаётся.

> ✅ `GET /playlists` принимает query `search` (опциональный, min 1 символ, полнотекстовый поиск по `title`/`description`: PostgreSQL FTS `russian` + `ts_rank`-ранжирование, порядок `rank DESC` → `id DESC`), `page`/`limit` (offset-пагинация, `limit` max 100; keyset-режима нет) и `sort`/`order` (`sort` ∈ {`date`,`title`,`section`}, направленные дефолты `date`→`desc` и алфавитные→`asc`; поиск игнорирует `sort`/`order`). `sort=date` упорядочивает по `date_trunc('milliseconds', created_at)` с tiebreak `id DESC`; ответы содержат `createdAt` (ISO `date-time`). Offset-путь пагинирует **родительские id** (`ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC` для дефолта `date`/`desc`, при поиске — `rank DESC, id DESC`, при `sort=section` — `GROUP BY playlist.id` с `MIN(LOWER(sections.title))`), считает общее число отдельным лёгким запросом и гидратирует страницу через `WHERE id IN (...)` с восстановлением порядка в памяти. Без `search`/`page`/`limit` отвечает полной выборкой, форма `{ playlists, count }` не меняется; порядок родителя в полной выборке — `createdAt DESC, id DESC` (дефолт `date`/`desc` идёт через `findAndCount`). Подробности — [`../modules/playlist.md`](../modules/playlist.md).

### Sections

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `POST /section` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SectionController.create` | `SectionService.createSectionItem` |
| `GET /section` | публичный | `SectionController.findAll` | `SectionService.findAllSectionItems` |
| `GET /section/:id` | публичный | `SectionController.findOne` | `SectionService.findOneSectionItem` |
| `PATCH /section/reorder` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SectionController.reorder` | `SectionService.reorderSections(ids)` |
| `PATCH /section/:id/playlists/reorder` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SectionController.reorderPlaylistsInSection` | `SectionService.reorderPlaylistsInSection(id, playlistIds)` |
| `PATCH /section/:id` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SectionController.update` | `SectionService.update` |
| `DELETE /section/:id` | `AuthGuard` + `RolesGuard` (admin, moderator) | `SectionController.remove` | `SectionService.remove` |

### Files (`AppController`)

> **Превью обложек (соглашение, вне OpenAPI):** для `artwork` вида `${MINIO_PUBLIC_URI}/files/<uuid>.<ext>` существует `${MINIO_PUBLIC_URI}/files/thumbs/<uuid>.webp` (WebP ≤ 640 px). Клиенты используют его для карточек и откатываются на оригинал, если превью нет — см. [minio.md](../modules/minio.md#превью-изображений-thumbs).

> ✅ `artworkBlurhash`: рядом с `artwork` в ответах sermons/playlists/sections (включая вложенные плейлисты и проповеди) отдаётся nullable BlurHash обложки — строка или `null`, пока хэш не посчитан (считается при загрузке через `PicturesService`). `GET /files` не менялся. Поле добавлено контрактом OpenAPI **0.23.5**.

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `POST /files` | `AuthGuard` + `RolesGuard` (admin, moderator) | `AppController.uploadFile` (лимит 100 MB, `fileFilter` по `MEDIA_EXTENSIONS`) | `MinioService.uploadFile` |
| `GET /files` | `AuthGuard` + `RolesGuard` (admin, moderator) | `AppController.listFiles` | `MinioService.listImages` (cover-reuse, элементы с `used`) |
| `GET /files/orphans` | `AuthGuard` + `RolesGuard` (admin, moderator) | `AppController.getOrphanedFiles` | `MinioService.listOrphans` (ограниченный скан `limit`, классификация против referenced-имён из БД) |
| `POST /files/orphans/cleanup` | `AuthGuard` + `RolesGuard` (admin, moderator) | `AppController.cleanupOrphanedFiles` | `MinioService.listFilesWithUsage` + `removeObjectByName` (только аудио/текст, best-effort) |
| `DELETE /files/:fileName` | `AuthGuard` + `RolesGuard` (admin, moderator) | `AppController.removeFile` | `MinioService.removeObjectByName` (изображения + неиспользуемые аудио/текст; `409` при использовании как обложка/в проповеди) |
| `GET /files/:fileName` | публичный | `AppController.getFile` (param `FileNameParamDto` — UUID + media-extension) | `MinioService.getFileUrl` (статический URL, bucket public-read) |

> ✅ Orphans-эндпоинты: `GET /files/orphans` возвращает `{ orphaned: FileMetadataDto[], count }` — медиа-объекты bucket (изображения + `.mp3/.pdf/.fb2`), не привязанные к `sermon.audioUrl/textFileUrl/artwork` или `playlist.artwork`; у каждого элемента `used: false`. Принимает query `limit` (`1..5000`, default `500`): скан стримится и останавливается, как только собрано `limit` осиротевших файлов, поэтому ответ ограничен `limit` (`count === orphaned.length`), а память не растёт с размером bucket. `POST /files/orphans/cleanup` удаляет **только** осиротевшие аудио/текстовые объекты (изображения не трогает — обложки управляются вручную из каталога), ответ `{ deleted: string[], failed: { fileName, reason }[] }`, идемпотентно и best-effort; сканирует весь bucket без капа (нужно удалить все осиротевшие). `DELETE /files/{fileName}` удаляет изображение или неиспользуемый аудио/текстовый объект; `409` при использовании (обложка / привязка к проповеди); расширение вне медиа-таксономии → `400`.

### Auth

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `POST /auth/login` | публичный | `AuthController.signIn` | `AuthService.signIn(username, password)` |
| `POST /auth/refresh` | публичный | `AuthController.refresh` | `AuthService.refreshTokens(refreshToken)` |
| `POST /auth/logout` | `AuthGuard` (без `@Roles`) | `AuthController.logout` | `AuthService.logout(refreshToken)` |
| `GET /auth/profile` | `AuthGuard` (без `@Roles`) | `AuthController.getProfile` | `AuthService.getProfile(req.user.id)` |

> ✅ `POST /auth/logout` доступен **любой аутентифицированной роли** (`admin` / `moderator` / `user`) — без `RolesGuard`. Отзывает refresh-токен (denylist, sha256-хэш в `revoked_refresh_token`); повторный logout с тем же токеном — тоже `204`. `POST /auth/refresh` **ротирует** пару: предъявленный refresh-токен отзывается в том же запросе (один живой refresh-токен на цепочку; повторный refresh со старым токеном → `401`). `AuthGuard` на каждом запросе сверяет `token_version` с живой строкой БД и берёт роль оттуда, поэтому понижение/удаление пользователя действует немедленно, а смена пароля (`token_version + 1`) отзывает все access- и refresh-токены сразу. Детали — [`../modules/auth.md`](../modules/auth.md).

### Users

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `GET /users` | `AuthGuard` + `RolesGuard` (admin) | `UsersController.findAll` | `UsersService.findAll(page, limit)` |
| `POST /users` | `AuthGuard` + `RolesGuard` (admin) | `UsersController.create` | `UsersService.create` |
| `GET /users/:id` | `AuthGuard` + `RolesGuard` (admin) | `UsersController.findOne` | `UsersService.findOne` |
| `PATCH /users/:id` | `AuthGuard` + `RolesGuard` (admin) | `UsersController.update` | `UsersService.update(id, dto, currentUserId)` |
| `PATCH /users/:id/password` | `AuthGuard` + `RolesGuard` (admin) | `UsersController.changePassword` | `UsersService.changePassword` |
| `DELETE /users/:id` | `AuthGuard` + `RolesGuard` (admin) | `UsersController.remove` | `UsersService.remove(id, currentUserId)` |

> ✅ В отличие от sermons/playlists, **все** users-эндпоинты защищены `AuthGuard` + `RolesGuard` с `@Roles(UserRole.Admin)` — включая `GET /users` и `GET /users/:id` (нет публичных чтений). Схемы: `UserResponse` `{ id, name, username, email, role }` (**без `password`**), `CreateUserRequest` `{ name, email, username, password, role? }`, `UpdateUserRequest` `{ name?, email?, username?, role? }`, `ChangePasswordRequest` `{ password }`. Роль: `zod.enum(['admin','moderator','user'])` — обязательна в ответах, опциональна в create/update (дефолт `'user'`). `PATCH /users/:id/password` и `DELETE /users/:id` возвращают **`204 No Content`** (не `StatusResponseDto`). Защита self-delete/last-admin/self-role-change (403) — [`../modules/users.md`](../modules/users.md).

> ⚠️ **Breaking change (спецификация 0.15.0):** `GET /users` больше не возвращает голый массив — ответ обёрнут в `{ users, count }` (`AllUsersResponse`), где `count` — общее число пользователей. Добавлены опциональные query `page`/`limit` (offset-пагинация, `limit` max 100, порядок `id DESC`; `limit` без `page` — первая страница). Старые admin-клиенты, ожидающие массив, должны быть обновлены.

### Invidious instances

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `GET /invidious-instances` | `AuthGuard` + `RolesGuard` (admin) | `InvidiousInstancesController.findAll` | `InvidiousInstancesService.findAll()` |
| `PUT /invidious-instances` | `AuthGuard` + `RolesGuard` (admin) | `InvidiousInstancesController.replace` | `InvidiousInstancesService.replace(urls)` |

> ✅ Хранит админ-управляемый список Invidious-инстансов для формы импорта проповедей. Оба эндпоинта **admin-only** (moderator без доступа) и отвечают **голым JSON-массивом** `InvidiousInstance[]` (`{ id: integer, url: string }`, без обёртки `{ items, count }`). `PUT` body — `{ urls: string[] }`: полная замена, каждый адрес обязан начинаться с `https://`, дубликаты → `400`; порядок массива = порядок в UI. Сервис сидирует два проверенных инстанса при пустой таблице. Детали — [`../modules/invidious-instances.md`](../modules/invidious-instances.md).

### Feature flags

| Эндпоинт | Guard | Метод контроллера | Метод сервиса |
|----------|-------|-------------------|----------------|
| `GET /feature-flags/me` | `OptionalAuthGuard` (опциональная аутентификация; без токена `200`, с невалидным/просроченным токеном `401`) | `FeatureFlagsController.getEffectiveForMe` | `FeatureFlagsService.getEffectiveForUser(userId \| undefined)` |
| `GET /feature-flags` | `AuthGuard` + `RolesGuard` (admin) | `FeatureFlagsController.findAll` | `FeatureFlagsService.findAll()` |
| `GET /feature-flags/:id/overrides` | `AuthGuard` + `RolesGuard` (admin) | `FeatureFlagsController.findOverrides` | `FeatureFlagsService.findOverrides(flagId)` |
| `POST /feature-flags` | `AuthGuard` + `RolesGuard` (admin) | `FeatureFlagsController.create` | `FeatureFlagsService.create(dto)` |
| `PATCH /feature-flags/:id` | `AuthGuard` + `RolesGuard` (admin) | `FeatureFlagsController.update` | `FeatureFlagsService.update(id, dto)` |
| `DELETE /feature-flags/:id` | `AuthGuard` + `RolesGuard` (admin) | `FeatureFlagsController.remove` | `FeatureFlagsService.remove(id)` |
| `PUT /feature-flags/:id/overrides/:userId` | `AuthGuard` + `RolesGuard` (admin) | `FeatureFlagsController.setOverride` | `FeatureFlagsService.setOverride(id, userId, value)` |
| `DELETE /feature-flags/:id/overrides/:userId` | `AuthGuard` + `RolesGuard` (admin) | `FeatureFlagsController.deleteOverride` | `FeatureFlagsService.deleteOverride(id, userId)` |

> ✅ Удалённые фича-флаги: глобальный дефолт (`feature_flag.enabled`) + пер-пользовательские исключения `grant`/`deny` (`feature_flag_override`). `GET /feature-flags/me` — с опциональной аутентификацией (`OptionalAuthGuard`) и отвечает `{ flags: [{ key, enabled }] }`: валидный Bearer-токен → эффективные флаги пользователя по единому правилу `(enabled AND нет deny) OR grant`; без токена → глобальные состояния (исключения не применяются); невалидный/просроченный токен → `401` (клиент обновит токен и повторит запрос). Правило едино для всех ролей — **админ-байпаса нет** (`admin`/`moderator` подчиняются тому же правилу). Управление флагами — **admin-only**. `POST` body `{ key (^[a-z][a-z0-9-]*$), title }`, `PATCH` body `{ key?, title?, enabled? }`, override body `{ value: 'grant' | 'deny' }`; дубликат `key` → `409`, отсутствующий флаг/пользователь → `404`. `GET /feature-flags/:id/overrides` отвечает `{ overrides: [{ flagId, userId, value, createdAt }] }` в порядке `createdAt ASC`, затем `userId ASC`; пустой список — валидный `200`, отсутствующий флаг → `404`. Флаги `read`/`study` сидируются миграцией. Детали — [`../modules/feature-flags.md`](../modules/feature-flags.md).

## База URL и аутентификация

- **Base URL:** `https://api.slovo-propovedi.ru` — публичный адрес развёрнутого API. Локально NestJS слушает порт `3000` (захардкожен в `src/main.ts`).
- **Аутентификация:** Bearer JWT, проверяется `AuthGuard` (`src/auth/guard/auth.guard.ts`); payload `{ id, email, role, tokenVersion? }` (zod-парсинг на входе, legacy-токены без `role` → `401` → refresh; живой пользователь и версия сессии перепроверяются по БД, роль берётся из БД). Авторизация по ролям — `RolesGuard` (`@Roles`, fail-closed). Access/refresh flow — см. [`../modules/auth.md`](../modules/auth.md).
- **Защита на сервере:** `AuthGuard` + `RolesGuard` на мутирующих эндпоинтах (см. таблицы выше) + `ZodValidationPipe` (strict) на всех границах.

## Связанные документы

- [README.md](./README.md) — индекс contracts
- [../architecture.md](../architecture.md) — bootstrap, env, runtime
- [../conventions.md](../conventions.md) — OpenAPI-first workflow, команды регенерации, DoD
- [../modules/sermon.md](../modules/sermon.md) — домен проповедей
- [../modules/playlist.md](../modules/playlist.md) — домен плейлистов
- Технический долг по кодогенерации и внешней спецификации — фиксируй отдельно (например, в `docs/debt.md`)
