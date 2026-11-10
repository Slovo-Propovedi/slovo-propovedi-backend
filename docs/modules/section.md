# Модуль `section` — разделы

Разделы — слайдеры плейлистов на главном экране сайта. Модуль: CRUD, enums оформления, глобальный reorder разделов, reorder плейлистов внутри раздела.

**Слой:** backend (module `section`)
**Статус:** актуально

> ⚠️ **Опечатка в имени директории:** `section` использует `src/section/interfacies/interface.ts` (с лишней буквой `a`), тогда как `sermon`/`playlist` — `interfaces/interface.ts`. Это осознанно зафиксировано в коде; менять без отдельного рефакторинга не стоит (или оформи как долг отдельно, например в `docs/debt.md`).

## Эндпоинты

| Метод / путь | Guard | Body/Param | DTO ответа | Метод сервиса |
|---------------|-------|------------|------------|----------------|
| `POST /section` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `CreateSectionDto` | `SectionResponseDto` | `createSectionItem` |
| `GET /section` | публичный | — | `AllSectionsResponseDto` | `findAllSectionItems` |
| `GET /section/:id` | публичный | `IdParamDto` | `SectionResponseDto` | `findOneSectionItem` |
| `PATCH /section/reorder` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `ReorderSectionsDto` | `StatusSectionResponseDto` | `reorderSections(ids)` |
| `PATCH /section/:id/playlists/reorder` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `IdParamDto` + `ReorderPlaylistsInSectionDto` | `StatusSectionResponseDto` | `reorderPlaylistsInSection(id, playlistIds)` |
| `PATCH /section/:id` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `IdParamDto` + `UpdateSectionDto` | `SectionResponseDto` | `update` |
| `DELETE /section/:id` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `IdParamDto` | `StatusSectionResponseDto` | `remove` |

`@Controller('section')` (`src/section/section.controller.ts`).

> ✅ `PATCH /section/reorder` объявлен **до** `PATCH /section/:id` — иначе `reorder` был бы проглочен как `:id`.

## Сущность `SectionEntity` (`src/section/entities/section.entity.ts`)

Таблица `section`. Экспортирует TS-типы-enums:

| Тип | Значения |
|-----|----------|
| `ItemsSize` | `'small' | 'middle' | 'large' | 'xLarge'` |
| `Transform` | `'high' | 'short' | 'middle'` |
| `WhereIsSlideTitleLocated` | `'on' | 'under' | 'bothOnAndUnder'` (`bothOnAndUnder` — заголовок и описание внизу карточки, заголовок над описанием) |

Колонки:

| Поле | Колонка | Тип | Ограничения |
|------|---------|-----|-------------|
| `id` | `id` | uuid | PK |
| `title` | `title` | varchar | NOT NULL |
| `description` | `description` | varchar | nullable |
| `position` | `position` | int | NOT NULL default 0 (глобальный порядок) |
| `itemsSize` | `items-size` | varchar | enum |
| `itemsRows` | `items-rows` | int | nullable |
| `transform` | `transform` | varchar | enum |
| `isDescriptionTitleOnSlideLarge` | `is-description-title-on-slide-large` | boolean | default false |
| `whereIsSlideTitleLocated` | `where-is-slide-title-located` | varchar | default `'under'` |
| `borderRadius` | `border-radius` | boolean | default false |
| `playlistJoins` | relation | — | `@OneToMany → SectionPlaylistJoinEntity`, cascade |
| `artworkBlurhash` | — (вычисляемое) | string \| null (в ответе) | BlurHash обложки у вложенных плейлистов и проповедей рядом с `artwork`; не колонка БД — нормализатор берёт значение из `picture` и ставит `null`, пока хэш не посчитан |

### `SectionPlaylistJoinEntity` — таблица `section_playlists_playlist`

`src/section/entities/section-playlist-join.entity.ts`.

| Колонка | Тип | Ограничения |
|---------|-----|-------------|
| `id` | uuid | PK (суррогатный) |
| `sectionId` | uuid | FK → section, CASCADE; UNIQUE(`sectionId`,`playlistId`) |
| `playlistId` | uuid | FK → playlist, CASCADE |
| `position` | int | NOT NULL default 0 |

## Сервис (`section.service.ts`)

- `createSectionItem` — **SERIALIZABLE**: `max(position)` + `(max ?? -1) + 1` (защита от конкурентных дублей глобальных позиций).
- `findAllSectionItems` / `findOneSectionItem` — тянет `SECTION_RELATIONS` (до вложенных плейлистов → проповедей) и нормализует в `NormalizedSection` / `NormalizedSectionPlaylist`, сортируя по `position` на уровне БД (`SECTION_ORDER`).
- `update` — только заданные поля + `replaceSectionPlaylists(id, playlistsIds)` (delete + reinsert в транзакции, если `playlistsIds` задан).
- `remove` — `delete(id)` → `{ status: 'success' }`.
- `findByIds(ids)` — bulk-выборка.

### `reorderSections(ids)` — глобальный порядок разделов

- Валидирует: не пусто, без дубликатов, **полный in-scope набор** (`ids.length === total` по таблице `section`) — иначе `BadRequestException`.
- **Локальный инвариант сервиса:** `ids` заново парсятся сгенерированной схемой `ReorderSectionsBody` (`zod.array(zod.uuid())`) до построения SQL — невалидный id → `400` без обращения к БД, даже если сервис вызван в обход DTO.
- **Одиночный `CASE id` UPDATE** позиций (вместо N запросов):

```ts
const positionCase = ids
  .map((id, index) => `WHEN '${id}' THEN ${index}`)
  .join(' ');
await sectionRepository.createQueryBuilder()
  .update(SectionEntity)
  .set({ position: () => `CASE id ${positionCase} END` })
  .where('id IN (:...ids)', { ids })
  .execute();
```

> ✅ Безопасность: `id` — uuid; проверяется и в `ReorderSectionsDto` (граница HTTP), и локально в сервисе перед интерполяцией в CASE.

### `reorderPlaylistsInSection(sectionId, playlistIds)`

- Проверяет раздел; валидирует полный набор join-ов (`playlistIds.length === total` по `sectionId`), отсутствие дубликатов, существование всех плейлистов.
- Одиночный `CASE id` UPDATE по `join.id` (см. `reorderSermonsInPlaylist` в [`playlist.md`](./playlist.md) — тот же шаблон).

## DTO

| Файл | Схема |
|------|-------|
| `src/section/dto/create-section.dto.ts` | создание раздела |
| `src/section/dto/update-section.dto.ts` | частичное обновление |
| `src/section/dto/reorder-sections.dto.ts` | `{ ids: uuid[] }` |
| `src/section/dto/reorder-playlists-in-section.dto.ts` | `{ playlistIds: uuid[] }` |
| `src/section/dto/section-response.dto.ts` | create/findOne |
| `src/section/dto/all-sections-response.dto.ts` | findAll |
| `src/section/dto/status-section-response.dto.ts` | reorder/update/remove |

> ✅ Входные схемы `CreateSectionDto`/`UpdateSectionDto` ограничены: `title` ≤ 300, `description` ≤ 10000, `itemsRows` — целое `0..100` (в ответах ограничений нет — legacy-строки должны сериализоваться). `playlistsIds` в update — ≤ 1000 элементов; `reorder`-массивы `ids`/`playlistIds` — ≤ 1000. Полная таблица лимитов — [`../contracts/rest-api.md`](../contracts/rest-api.md).

## Связанные документы

- [README.md](./README.md) — индекс модулей
- [playlist.md](./playlist.md) — плейлисты и их membership в разделах
- [shared.md](./shared.md) — `IdParamDto`
- [../db.md](../db.md) — сущности и связи
- [../contracts/rest-api.md](../contracts/rest-api.md) — контракт `SectionController*`
- Домен playlists на фронте (разделы связаны) — репозиторий `slovo-propovedi-admin`
