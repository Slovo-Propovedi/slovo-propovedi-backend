# Модуль `playlist` — плейлисты

Упорядоченные подборки проповедей. Модуль: CRUD, bulk-replace состава (`replacePlaylistSermons`), reorder проповедей внутри плейлиста (одиночный `CASE` UPDATE), синхронизация членства в разделах.

**Слой:** backend (module `playlist`)
**Статус:** актуально

## Эндпоинты

| Метод / путь | Guard | Body/Param | DTO ответа | Метод сервиса |
|---------------|-------|------------|------------|----------------|
| `POST /playlists` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `CreatePlaylistDto` | `PlaylistResponseDto` | `create` |
| `GET /playlists` | публичный | query `FindAllPlaylistsQueryDto` (`search?`, `page?`, `limit?`, `sort?`, `order?`) | `AllPlaylistsResponseDto` | `findAll(search, page, limit, sort, order)` |
| `GET /playlists/:id` | публичный | `IdParamDto` | `PlaylistResponseDto` | `findOne` |
| `PATCH /playlists/:id/sermons/reorder` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `IdParamDto` + `ReorderSermonsInPlaylistDto` | `StatusPlaylistResponseDto` | `reorderSermonsInPlaylist(id, sermonIds)` |
| `PATCH /playlists/:id` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `IdParamDto` + `UpdatePlaylistDto` | `PlaylistResponseDto` | `update` |
| `DELETE /playlists/:id` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | `IdParamDto` | `StatusPlaylistResponseDto` | `remove` |

`@Controller('playlists')` (`src/playlist/playlist.controller.ts`).

## Сущности

### `PlaylistEntity` — таблица `playlist`

`src/playlist/entities/playlist.entity.ts`.

| Поле | Колонка | Тип | Примечание |
|------|---------|-----|------------|
| `id` | `id` | uuid | PK |
| `title` / `description` / `artwork` | — | varchar | NOT NULL |
| `artworkBlurhash` | — (вычисляемое) | string \| null (в ответе) | BlurHash обложки рядом с `artwork`; не колонка БД — нормализатор берёт значение из `picture` и ставит `null`, пока хэш не посчитан (считается при загрузке через `PicturesService`) |
| `createdAt` | `created_at` | timestamptz | NOT NULL, default `now()` — дата добавления; ключ `sort=date`; сериализуется в ответ |
| `sectionJoins` | relation | — | `@OneToMany → SectionPlaylistJoinEntity`, cascade |
| `sermonJoins` | relation | — | `@OneToMany → PlaylistSermonJoinEntity`, cascade |

### `PlaylistSermonJoinEntity` — таблица `playlist_sermons_sermon`

`src/playlist/entities/playlist-sermon-join.entity.ts`. Join «проповедь в плейлисте» с порядком.

| Колонка | Тип | Ограничения |
|---------|-----|-------------|
| `id` | uuid | PK (суррогатный) |
| `playlistId` | uuid | FK → playlist, CASCADE; UNIQUE(`playlistId`,`sermonId`) |
| `sermonId` | uuid | FK → sermon, CASCADE |
| `position` | int | NOT NULL default 0 |

Сервис тянет `PLAYLIST_RELATIONS` и нормализует в `NormalizedPlaylistResponse` (`normalizePlaylist`), сортируя `sermonJoins` и `sectionJoins` по `position` на уровне БД (`PLAYLIST_ORDER`).

## `findAll` — полная выборка, offset-пагинация и полнотекстовый поиск (`playlist.service.ts`)

Сигнатура: `findAll(search?, page?, limit?, sort?, order?)`. Три пути:

| Условие | Путь | Как фильтрует |
|---------|------|----------------|
| `page`/`limit` задан | **offset** | пагинация **родительских id** (join-свободный запрос) + отдельный дешёвый `getCount` + гидрация страницы через `WHERE id IN (...)` + восстановление порядка в памяти |
| `search` задан (без `page`/`limit`) | **поиск** | QueryBuilder (`getManyAndCount`): `playlist.search_vector @@ tsquery`, порядок по релевантности |
| ни то, ни другое | **полная выборка** | `findAndCount` для дефолта `date`/`desc` (порядок родителя `createdAt DESC, id DESC`); иначе — тот же QueryBuilder с сортировкой вместо `rank`-порядка |

`limit` без `page` означает первую страницу (`page = 1`); `page` без `limit` — размер страницы по умолчанию `DEFAULT_PAGE_LIMIT = 100` (максимум схемы). У плейлистов нет keyset-режима, поэтому правило взаимоисключения (как у sermons) не нужно.

### Offset-пагинация: пагинация id, а не join-запроса

Прежний `findAndCount`-по-join-ам пагинировал **декартово произведение** глубокого графа отношений: страница из N плейлистов могла вернуть меньше N строк (или дубликаты), как только у плейлиста появлялось несколько проповедей/разделов. Поэтому offset-путь:

1. **Страница родительских id** — join-свободный запрос `SELECT playlist.id` с `ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC` для дефолта `date`/`desc` (при поиске — `rank DESC, id DESC`; для `title`/`section` — соответствующие ключи, см. ниже) и `skip`/`take`.
2. **Общее число** — отдельный лёгкий `getCount` (`countPlaylists`, поисковый фильтр применён при наличии) вместо `getManyAndCount` по join-размножению; значение совпадает (оба считают distinct плейлисты).
3. **Гидрация страницы** — существующая загрузка отношений (`PLAYLIST_RELATIONS` + `PLAYLIST_ORDER`) с `WHERE id IN (страница)`.
4. **Восстановление порядка в памяти** — `WHERE IN` теряет порядок id-страницы, поэтому гидратированные строки переупорядочиваются по порядку id-страницы. Отсутствующая строка (нарушенный FK: id-страница видела плейлист, гидрация — нет) — fail-fast с `Error`, а не молчаливое выпадение из ответа.

Без `page`/`limit` порядок родителя в полной выборке — **`createdAt DESC, id DESC`** для дефолта `date`/`desc` (детерминированный tiebreak по `id`).

### Сортировка (`sort`/`order`)

`sort` ∈ {`date`, `title`, `section`}, `order` ∈ {`asc`, `desc`}. Значения по умолчанию **направленные**: `sort=date` → `order=desc`; для алфавитных сортировок (`title`/`section`) отсутствующий `order` → `asc`. Направление резолвится в DTO (`.transform`, читает **резолвленный** `sort`, поэтому отсутствующий `sort` даёт `date`/`desc`); сервис хранит то же правило (`order ?? (sort === 'date' ? 'desc' : 'asc')`) как fallback для прямых вызовов. Keyset-режима у плейлистов нет, поэтому правила взаимоисключения (как у sermons) не требуется.

`ORDER BY` (tiebreak — `playlist.id DESC`; `date` усечён до миллисекунд — единая точность с sermon-keyset):

| `sort` | `ORDER BY` |
|--------|------------|
| `date` | `date_trunc('milliseconds', playlist.created_at) <dir>, playlist.id DESC` |
| `title` | `LOWER(playlist.title) <dir>, playlist.id DESC` |
| `section` | `LOWER(sections.title) <dir> NULLS LAST, sectionJoins.position <dir>, playlist.id DESC` |

- `LOWER(...)` — регистронезависимая алфавитная сортировка; `NULLS LAST` оставляет плейлисты без разделов в конце **в обоих направлениях**.
- `section` упорядочивает по названию «первого» раздела — с наименьшим `LOWER(title)` (при равенстве — с наименьшей позицией join-а); в offset-режиме это явные `MIN(LOWER(sections.title))` / `MIN(sectionJoins.position)`.
- **Поиск игнорирует `sort`/`order`** — ранжированный порядок `(rank DESC, id DESC)` побеждает (спецификация: «при поиске сортировка игнорируется»).
- В полной выборке к сортировке добавляются позиции join-ов (`sermonJoins.position ASC`, `sectionJoins.position ASC`) — как в поисковом пути.

В полной выборке пара `date`/`desc` (дефолт) сохраняет прежний `findAndCount`-путь байт-в-байт; любая другая уходит в тот же QueryBuilder, что и поиск (`buildPlaylistSearchQueryBuilder`). В offset-режиме `sort=section` пагинирует родительские id через `GROUP BY playlist.id` с `MIN(LOWER(sections.title))` — join по разделам не размножает страницу (плейлист в нескольких разделах занимает ровно одну строку), — а `sort=title` использует `LOWER(playlist.title)` в join-свободном id-запросе.

### Полнотекстовый поиск (FTS)

Поиск — **независимый от порядка слов** (AND по всем словам запроса) и **ранжированный по релевантности**, на PostgreSQL full-text search (`russian` конфигурация):

- Все поисковые поля свёрнуты в **генерируемую колонку** `playlist.search_vector` (`GENERATED ALWAYS AS ... STORED`, PostgreSQL >= 12) с весами `setweight`:
  - `A` — `title` (наивысший приоритет);
  - `D` — `description` (наинизший).
- Веса — **единый источник правды** в коде: `PLAYLIST_SEARCH_WEIGHTS` + `buildPlaylistSearchVectorExpression()` (`src/playlist/playlist.service.ts`); SQL-миграция [`sql/migrations/006_playlist_search_tsvector.sql`](../../sql/migrations/006_playlist_search_tsvector.sql) и `sql/bootstrap.sql` используют то же выражение (дрейф ловится спеками).
- Ранжирование: `ts_rank('{0.1,0.2,0.4,1.0}'::float4[], playlist.search_vector, tsquery)` — массив весов в порядке **D, C, B, A** (description 0.1, title 1.0; неиспользуемые C/B — дефолт 0.2/0.4). Тот же массив, что в sermon-поиске.
- GIN-индекс `"IDX_playlist_search_vector"` покрывает `search_vector @@ tsquery` (миграция 006 + `sql/bootstrap.sql`).

### Санитизация на границе (parse, don't validate)

`buildSearchTsQuery` — **переиспользуется из sermon-сервиса** (`src/sermon/sermon.service`), не дублируется: та же чистая функция на границе строит tsquery из строки поиска (только буквы/цифры, `:*` на каждом токене, AND между токенами — порядок слов не важен). Строка без единого словного символа (`"&&&"`) → `BadRequestException` (fail fast). Подробности — [`sermon.md`](./sermon.md).

### Условие и ранжирование

`tsquery` строится **один раз на запрос** и биндится параметром `:tsquery`; выражение оборачивается в `to_tsquery('russian', ...)` (стеммер применяется и к запросу, и к вектору):

```ts
PLAYLIST_TS_SEARCH_CONDITION = "playlist.search_vector @@ to_tsquery('russian', :tsquery)";
RANK_EXPRESSION = "ts_rank('{0.1,0.2,0.4,1.0}'::float4[], playlist.search_vector, to_tsquery('russian', :tsquery))";
```

Порядок: **`rank DESC` → `playlist.id DESC`** → позиции join-ов (`sermonJoins.position`, `sectionJoins.position`) на уровне БД — та же реляционная модель, что у `findAndCount`.

> ✅ `findAll` без `search`/`page`/`limit` отдаёт **всю** выборку (backward-compat); форма ответа `{ playlists, count }` не изменилась ни в одном из путей.

## `create` (SERIALIZABLE)

- SERIALIZABLE-транзакция: сохраняет плейлист, затем — если `sermonsIds` задан — проверяет существование всех проповедей (`findByIds`), создаёт join-строки с позицией = индексу в массиве.
- **`description: null` → `''`.** Схема `PlaylistControllerCreateBody` допускает `description: null`, но колонка `playlist.description` в БД — `NOT NULL` (см. [`../db.md`](../db.md), `sql/bootstrap.sql`), поэтому сервис приводит `null` к пустой строке на границе: `description: dto.description ?? ''`. Иначе INSERT с `NULL` падал бы HTTP 500 (нарушение not-null constraint).
- Если `sectionsIds` задан — валидация в той же транзакции (зеркало `sermonsIds`-флоу): дубликаты → `400 Bad Request` (`Duplicate section IDs detected`), несуществующий раздел → `404 Not Found` (`Some sections not found`). Ошибка откатывает транзакцию — плейлист не сохраняется.
- После коммита, если `sectionsIds` задан — прикрепление к разделам через `attachPlaylistToSections` (SERIALIZABLE, `max(position) + 1`); пустой/отсутствующий массив — no-op. Паттерн «attach после create-транзакции» зеркалит `SermonService.create` → `attachSermonToPlaylists` (хелпер сам открывает SERIALIZABLE-транзакцию, поэтому не вызывается внутри create-транзакции).
- Перечитывает после коммита (`findOne`) — ответ отражает полностью сохранённый плейлист.

## `update` и `replacePlaylistSermons`

- `update` обновляет только заданные поля (`title`/`description`/`artwork`), затем:
  - если `sermonsIds` задан → `replacePlaylistSermons(id, sermonsIds)` (bulk-replace состава);
  - если `sectionsIds` задан → `syncPlaylistSectionMembership(playlist, sectionsIds)`.
- Если `description` задан и равен `null` — то же приведение, что в `create`: `playlist.description = dto.description ?? ''` (UPDATE с `NULL` нарушил бы `NOT NULL` так же, как INSERT).

`replacePlaylistSermons` — **delete + reinsert в одной транзакции**, чтобы сбой вставки не оставил плейлист без проповедей:

```ts
await this.dataSource.transaction(async (manager) => {
  const joinRepository = manager.getRepository(PlaylistSermonJoinEntity);
  await joinRepository.delete({ playlistId });
  if (sermonIds.length === 0) return;
  const joinRows = sermonIds.map((sermonId, index) =>
    joinRepository.create({ playlistId, sermonId, position: index }),
  );
  await joinRepository.save(joinRows);
});
```

> ✅ Bulk-replace: `PATCH /playlists/:id` с `{ sermonsIds: [...] }` **заменяет** весь состав плейлиста (перезаписывает `position` индексами массива), а не патчит точечно.

## `reorderSermonsInPlaylist(playlistId, sermonIds)`

- Валидирует: массив не пуст, без дубликатов, и **полный in-scope набор** (`sermonIds.length === total` по `playlistId`) — иначе `BadRequestException` (частичный список «схлопнул» бы позиции).
- Проверяет, что все проповеди реально в плейлисте.
- **Одиночный `CASE id` UPDATE** позиций вместо N запросов:

```ts
const positionCase = sermonIds
  .map((sermonId, index) => {
    const join = joinBySermonId.get(sermonId);
    if (!join) throw new NotFoundException(...);
    return `WHEN '${join.id}' THEN ${index}`;
  })
  .join(' ');
await joinRepository.createQueryBuilder()
  .update(PlaylistSermonJoinEntity)
  .set({ position: () => `CASE id ${positionCase} END` })
  .where('id IN (:...ids)', { ids: joins.map((join) => join.id) })
  .execute();
```

> ✅ `join.id` — uuid, генерируется БД, поэтому интерполяция в CASE безопасна.

## `syncPlaylistSectionMembership`

Аналогична `syncSermonPlaylistMembership`: разница текущих `sectionJoins` и желаемого набора `sectionsIds` → удаление лишних, добавление недостающих через `attachPlaylistToSections` (SERIALIZABLE, `max(position) + 1`).

## `remove`

`delete(id)` → `{ status: 'success' }`. Каскады по join-таблицам — на стороне БД.

## DTO

| Файл | Схема |
|------|-------|
| `src/playlist/dto/create-playlist.dto.ts` | `{ title, description, artwork, sermonsIds?, sectionsIds? }` — `artwork`: пустая строка или `http(s)://`-URL (`javascript:`/`data:` отклоняются) |
| `src/playlist/dto/update-playlist.dto.ts` | `{ title, description, artwork, sermonsIds, sectionsIds? }` — то же ограничение `artwork` |
| `src/playlist/dto/find-all-playlists-query.dto.ts` | extends query + `.extend({ search: z.string().trim().min(1).max(200).optional(), page: z.coerce.number().int().min(1).max(100000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), sort: z.enum(['date','title','section']).optional(), order: z.enum(['asc','desc']).optional() })` + `.transform(...)` — резолв направленных дефолтов `sort`/`order` |
| `src/playlist/dto/reorder-sermons-in-playlist.dto.ts` | `{ sermonIds: uuid[] }` |
| `src/playlist/dto/playlist-response.dto.ts` | create/findOne |
| `src/playlist/dto/all-playlists-response.dto.ts` | findAll |
| `src/playlist/dto/status-playlist-response.dto.ts` | remove |

## Связанные документы

- [README.md](./README.md) — индекс модулей
- [sermon.md](./sermon.md) — проповеди и их membership-синхронизация
- [section.md](./section.md) — разделы и `section_playlists_playlist`
- [shared.md](./shared.md) — `IdParamDto`
- [../db.md](../db.md) — сущности и связи
- [../contracts/rest-api.md](../contracts/rest-api.md) — контракт `PlaylistController*`
- Домен playlists на фронте — репозиторий `slovo-propovedi-admin`
