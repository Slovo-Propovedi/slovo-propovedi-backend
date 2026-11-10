# Модуль `sermon` — проповеди

Проповедь — основная единица контента. Модуль: CRUD, поиск (полнотекстовый, независимый от порядка слов, с ранжированием по релевантности: PostgreSQL FTS `russian` + `ts_rank`), пагинация (keyset `take`/`cursor` **или** offset `page`/`limit`), синхронизация членства в плейлистах.

**Слой:** backend (module `sermon`)
**Статус:** актуально

## Эндпоинты

| Метод / путь | Guard | Query/Body/Param | DTO ответа | Метод сервиса |
|---------------|-------|------------------|------------|----------------|
| `POST /sermons` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | body `CreateSermonDto` | `SermonResponseDto` | `create` |
| `GET /sermons` | публичный | query `FindAllSermonsQueryDto` | `AllSermonsResponseDto` | `findAll(take, cursor, search, page, limit, sort, order)` |
| `GET /sermons/distinct-values` | публичный | — | `DistinctValuesResponseDto` | `getDistinctValues` |
| `GET /sermons/:id` | публичный | param `IdParamDto` | `SermonResponseDto` | `findOne` |
| `PATCH /sermons/:id` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | param + body `UpdateSermonDto` | `StatusSermonResponseDto` | `update` |
| `DELETE /sermons/:id` | ✅ `AuthGuard` + `RolesGuard` (admin, moderator) | param `IdParamDto` | `StatusSermonResponseDto` | `remove` |

`@Controller('sermons')` (`src/sermon/sermon.controller.ts`).

## Сущность `SermonEntity` (`src/sermon/entities/sermon.entity.ts`)

Таблица `sermon`. Полная карта колонок — в [`../db.md`](../db.md); ключевое:

| Поле | Колонка | Тип | Примечание |
|------|---------|-----|------------|
| `id` | `id` | uuid | PK |
| `title` / `description` / `artist` / `artwork` | — | varchar | NOT NULL |
| `artworkBlurhash` | — (вычисляемое) | string \| null (в ответе) | BlurHash обложки рядом с `artwork`; не колонка БД — нормализатор берёт значение из `picture` и ставит `null`, пока хэш не посчитан (считается при загрузке через `PicturesService`) |
| `textFileUrl` / `audioUrl` / `youtubeUrl` | `text-file-url` / `audio-url` / `youtube-url` | varchar | nullable |
| `book` | `book` | varchar | nullable |
| `chapter` | `chapter` | json | nullable (`number \| number[]`) — одиночная глава или диапазон `[start, end]` |
| `verse` | `verse` | json | nullable (`number \| number[] \| (number \| number[])[]`) — стих, диапазон `[start, end]` или список разрозненных отрезков `[[9,18],20]` |
| `createdAt` | `created_at` | timestamptz | NOT NULL, default `now()` — дата добавления; ключ `sort=date` и keyset-курсора; сериализуется в ответ |
| `playlistJoins` | relation | — | `@OneToMany → PlaylistSermonJoinEntity`, cascade |

Сервис тянет глубокие отношения (`SERMON_RELATIONS` — до плейлистов, разделов и вложенных проповедей) и нормализует их в `NormalizedSermonResponse` (`normalizeSermonRelations` / `normalizePlaylistRelations`), сортируя join-ы по `position` на уровне БД (`SERMON_RELATION_ORDER`). Так делает `findOne`; `findAll` собирает тот же граф из линейных запросов (см. ниже) — глубокий join остался только у `findOne`.

## `findAll` — полная выборка, keyset- и offset-пагинация (`sermon.service.ts`)

Сигнатура: `findAll(take?, cursor?, search?, page?, limit?, sort?, order?)`. Три пути:

| Условие | Путь | Как фильтрует |
|---------|------|----------------|
| `page`/`limit` задан | **offset** | join-свободная страница (`skip`/`take`) + `getCount` (`countSermons`) + `assembleSermonGraph`; `count` — **общее** число совпадений, `nextCursor: null` |
| `take` задан (без `page`) | **keyset (cursor)** | QueryBuilder: `take + 1` строк; порядок по релевантности + курсор `{ rank, id }`, без поиска — порядок по дате + курсор `{ createdAt, id }` |
| ни то, ни другое | **полная выборка** | join-свободная страница (`getMany`) + `getCount` (`countSermons`) + `assembleSermonGraph` (линейные запросы); `sermon.search_vector @@ tsquery`, порядок по релевантности |

`page` и `limit` **взаимоисключительны** с `take`/`cursor` (одновременное использование → `400 Bad Request`; правило навешивается в DTO через `superRefine`). `limit` без `page` означает первую страницу (`page = 1`); `page` без `limit` — размер страницы по умолчанию `DEFAULT_PAGE_LIMIT = 100` (максимум схемы). `sort`/`order` **взаимоисключительны** с `take`/`cursor` (см. ниже).

### Сортировка (`sort`/`order`)

`sort` ∈ {`date`, `title`, `artist`, `playlist`}, `order` ∈ {`asc`, `desc`}. Значения по умолчанию **направленные**: `sort=date` → `order=desc`; для алфавитных сортировок (`title`/`artist`/`playlist`) отсутствующий `order` → `asc`. Направление резолвится в DTO (`.transform`), поэтому сервис всегда получает готовую пару; сигнатура сервиса хранит то же правило (`order ?? (sort === 'date' ? 'desc' : 'asc')`) как fallback для прямых вызовов без DTO.

`sort`/`order` **взаимоисключительны** с `take`/`cursor`: одновременное использование → `400 Bad Request` (`'sort and order are mutually exclusive with take and cursor'` по пути `sort`). Keyset-пагинация опирается на фиксированный порядок (`date` — `(created_at, id)`, поиск — `(rank, id)`), произвольная сортировка с ней несовместима. `sort`/`order` работают в offset-режиме и в полной выборке.

`ORDER BY` (tiebreak — `sermon.id`; для даты направление tiebreak-а совпадает с направлением сортировки, для остальных — фиксированный `DESC`):

| `sort` | `ORDER BY` |
|--------|------------|
| `date` | `date_trunc('milliseconds', sermon.created_at) <dir>, sermon.id <dir>` |
| `title` | `LOWER(sermon.title) <dir>, sermon.id DESC` |
| `artist` | `LOWER(sermon.artist) <dir>, sermon.id DESC` |
| `playlist` | `LOWER(playlist.title) <dir> NULLS LAST, playlistSermonJoin.position <dir>, sermon.id DESC` |

- `LOWER(...)` — регистронезависимая алфавитная сортировка; `NULLS LAST` оставляет проповеди без плейлиста в конце **в обоих направлениях**.
- `playlist` упорядочивает по названию «первого» плейлиста — с наименьшим `LOWER(title)` (при равенстве — с наименьшей позицией join-а); в offset-режиме это явные `MIN(LOWER(playlist.title))` / `MIN(playlistSermonJoin.position)`.
- **Поиск игнорирует `sort`/`order`** — ранжированный порядок `(rank DESC, id DESC)` побеждает (спецификация: «при поиске сортировка игнорируется»).

Полная выборка с `sort=playlist` использует обычный (не `leftJoinAndSelect`) `leftJoin` на плейлисты: `getMany` группирует по PK, поэтому проповедь с несколькими плейлистами появляется ровно один раз. Offset-режим с `sort=playlist` пагинирует **родительские id** через `GROUP BY sermon.id` (`findSermonsOffsetPageByPlaylist`) — join размножил бы строки и недозаполнил страницу, — а затем гидратирует страницу по id и восстанавливает порядок в памяти; прочие сортировки в offset-режиме идут через прежний join-свободный page-запрос.

### Полнотекстовый поиск (FTS)

Поиск — **независимый от порядка слов** (AND по всем словам запроса) и **ранжированный по релевантности**, на PostgreSQL full-text search (`russian` конфигурация):

- Все поисковые поля свёрнуты в **генерируемую колонку** `sermon.search_vector` (`GENERATED ALWAYS AS ... STORED`, PostgreSQL >= 12) с весами `setweight`:
  - `A` — `title` (наивысший приоритет);
  - `B` — `artist`, `book`;
  - `D` — `description` (наинизший).
- Веса — **единый источник правды** в коде: `SEARCH_WEIGHTS` + `buildSearchVectorExpression()` (`src/sermon/sermon.service.ts`); SQL-миграция [`sql/migrations/005_sermon_search_tsvector.sql`](../../sql/migrations/005_sermon_search_tsvector.sql) и `sql/bootstrap.sql` используют то же выражение (дрейф ловится спеками).
- Ранжирование: `ts_rank('{0.1,0.2,0.4,1.0}'::float4[], sermon.search_vector, tsquery)` — массив весов в порядке **D, C, B, A** (description 0.1, artist/book 0.4, title 1.0; неиспользуемый C — дефолт 0.2).

### Стратегия tsquery: `to_tsquery` + префикс `:*`

Выбрана **`to_tsquery('russian', ...)` с `:*` на каждом токене**, а не `websearch_to_tsquery` (проверено на throwaway-БД, см. ниже):

| Критерий | `websearch_to_tsquery` | `to_tsquery` + `:*` |
|----------|------------------------|----------------------|
| Многословный AND | ✅ | ✅ |
| Независимость от порядка слов | ✅ | ✅ |
| Префикс частичного слова (`благода` → `благодать`) | ❌ | ✅ |
| Русский стеммер: `Иван`→`ива`, `Иванов`→`иван` | ❌ (`иван` не находит `Иванов`) | ✅ (`ива:*` находит оба) |

Русский стеммер асимметричен (`Иван` → лексема `ива`, `Иванов` → `иван`): `websearch_to_tsquery('russian', 'благодать иван')` = `'благода' & 'ива'` — точное совпадение лексем не находит `Иванов`. Префикс `:*` компенсирует асимметрию.

### Санитизация на границе (parse, don't validate)

`buildSearchTsQuery(search)` — **чистая функция на границе**, одна для обоих путей:

```ts
const SEARCH_MAX_TOKENS = 40;

const buildSearchTsQuery = (search: string): string => {
  const tokens = search.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) throw new BadRequestException('search must contain at least one word character');
  if (tokens.length > SEARCH_MAX_TOKENS) throw new BadRequestException('Search query is too complex');
  return tokens.map((token) => `${token}:*`).join(' & ');
};
```

- Оставляет только «словные» символы (буквы/цифры, включая кириллицу) — синтаксис tsquery (`&`, `|`, `!`, `(`, `)`, `:`, `*`, `<`, `>`) в SQL не проходит.
- Каждый токен получает `:*` (частичное слово) и соединяется `&` (AND, порядок слов не важен).
- Пустой результат после санитизации (`"&&&"`) → `BadRequestException` (fail fast).
- **Потолок токенов — defense-in-depth.** Спека ограничивает `search` 200 символами (`maxLength`), но 200 символов могут дать ~100 односимвольных слов; каждое слово — отдельная лексемная проверка в `to_tsquery`, то есть CPU-амплификация. Больше 40 санитизированных токенов → `400 Bad Request` `Search query is too complex`. Запрос **не усекается** молча: усечённый tsquery вернул бы не те совпадения, поэтому fail fast.

### Условие и ранжирование (общие для обоих путей)

`tsquery` строится **один раз на запрос** и биндится параметром `:tsquery`; выражение оборачивается в `to_tsquery('russian', ...)`. Стеммер применяется и к запросу, и к вектору — **сырой текст в `@@` не стеммится** и не находит совпадений:

```ts
TS_SEARCH_CONDITION = "sermon.search_vector @@ to_tsquery('russian', :tsquery)";
RANK_EXPRESSION = "ts_rank('{0.1,0.2,0.4,1.0}'::float4[], sermon.search_vector, to_tsquery('russian', :tsquery))";
```

### Keyset-пагинация

- **Без search** — порядок `(date_trunc('milliseconds', created_at) <dir>, sermon.id <dir>)`, курсор непрозрачный `{ createdAt, id }` (base64 JSON, ISO-строка с миллисекундами), сравнение — row-value по той же trunc-выраженной паре:

  ```sql
  (date_trunc('milliseconds', sermon.created_at), sermon.id) < (:createdAt::timestamptz, :id)
  ```

  Оператор зависит от направления: `<` для `desc`, `>` для `asc`. Старые голые uuid-курсоры инвалидированы (`invalid or stale cursor`).
- **Инвариант точности.** `nextCursor` строится из `entity.createdAt.toISOString()` (JS Date = миллисекунды), а `ORDER BY`/предикат используют `date_trunc('milliseconds', created_at)`. Поэтому хранимые значения `created_at` должны быть миллисекундно-точными: при µs-точном значении `trunc_ms != entity_ms`. Бэкфилл `scripts/backfill-created-at.mjs` поэтому усекает все кандидаты (mtime объектов MinIO и `MIN(created_at)` связанных проповедей) до целых миллисекунд. Драйвер `pg` парсит `timestamptz` (OID 1184) с **floor** суб-миллисекундного остатка — это закреплено спекой `src/db/pg-timestamptz-parsing.spec.ts`; если будущая версия `pg` начнёт округлять, курсор нужно перевести на raw-значение `date_trunc('milliseconds', created_at)::text` (шаблон — rank-raw в поисковом режиме).
- **С search** — порядок `(rank DESC, sermon.id DESC)`, поэтому **голый id-курсор неверен**: курсор составной `{ rank, id }`, непрозрачный для клиента (base64 JSON). Пагинация — row-value сравнением:

  ```sql
  (ts_rank('{0.1,0.2,0.4,1.0}'::float4[], sermon.search_vector, to_tsquery('russian', :tsquery)), sermon.id) < (:rank::float4, :id)
  ```

  Ранг в БД — `float4`; JS-число (`float8`) приводится обратно `::float4`, иначе float-округление при равных рангах пропускает/дублирует строки.
- Старые курсоры (голый uuid) **инвалидированы** — `decodeCompositeCursor` бросает `BadRequestException('invalid or stale cursor')`.
- `take + 1` строк; лишняя строка решает, есть ли следующая страница. Ранг последней строки берётся из raw-строк запроса (`addSelect(RANK_EXPRESSION, 'rank')` + `getRawAndEntities`).

### Ограничение TypeORM (почему ранк — через select-алиас)

`getMany`/`getRawAndEntities` с `take` + join-ами пагинирует двумя запросами и **не умеет** сложное выражение в `ORDER BY` (разбирает строку как `alias.column` и падает на `'{0.1,...`). Поэтому ранг выносится в **select-алиас**: `addSelect(RANK_EXPRESSION, 'rank')` + `orderBy('rank', 'DESC')` — алиас переживает подзапрос пагинации, а `rank` в сущность не попадает (unmapped).

### Полная выборка и сборка графа (production OOM-фикс)

Полная выборка (без `take`) — join-свободная страница проповедей + `assembleSermonGraph`: граф отношений собирается из ~10 ограниченных линейных запросов (page-проповеди; `playlist_sermons` по `sermonId` страницы; `playlists` по id; `playlist_sermons` по `playlistId` — включая проповеди вне страницы; недостающие проповеди; вложенные `playlist_sermons`; вложенные `playlists` проекцией `{id, title}`; `section_playlists`; `sections`) и склеивается через `Map`. Результат кормит те же `normalizeSermonRelations` / `normalizePlaylistRelations`, что и прежний join — HTTP-контракт байт-в-байт не изменился.

**Зачем:** прежний 8-уровневый `leftJoinAndSelect` давал декартово размножение строк и OOM-убивал контейнер (256 МБ) на `GET /sermons` без `take` при ~420 проповедях. Пик памяти теперь ограничен размером ответа (~1300 строк для 421 проповеди / 20 плейлистов / 421 связи), а не взрывом join-ов.

- `count` в полной выборке — дешёвый `getCount()` (`countSermons`), а не `getManyAndCount` по join-размножению; значение совпадает (оба считают distinct проповеди).
- Самые глубокие вложенные плейлисты теперь явно упорядочены по позиции join-а ASC (ранее — порядок из БД, произвольный).
- Вспомогательные помощники: `countSermons`, `uniqueIds`, `groupJoinsBy`. Репозитории `SectionEntity` + `SectionPlaylistJoinEntity` инжектируются в модуль (`src/sermon/sermon.module.ts`).
- Отсутствующие связанные строки (нарушенные FK) — fail-fast с `Error`, а не пустой результат.
- Keyset-путь (`take` + `cursor`) использует составной курсор: `{ rank, id }` при поиске и `{ createdAt, id }` для даты; offset-путь (`page`/`limit`) использует тот же join-свободный page-запрос с `skip`/`take`; все пути используют единое FTS-условие и ранжирование.

Ответ: `{ sermons, count, nextCursor }` — форма не изменилась. В полной выборке и offset-режиме `count` — общее число совпадений, `nextCursor: null`; в keyset-режиме `count: null`, `nextCursor` — курсор следующей страницы (или `null`).

> ✅ `findAll` без `take`/`search`/`page`/`limit` отдаёт **всю** выборку (backward-compat, используется админкой при первичной загрузке). Поиск применён во **всех** путях.

## `getDistinctValues` — уникальные проповедники и книги (автодополнение)

Отдаёт два **независимых** списка ранее использованных значений — `{ artists, books }` — для автодополнения полей `artist`/`book` в формах админки.

- **Два отдельных запроса**, а не `DISTINCT` по двум колонкам вместе: `SELECT DISTINCT (artist, book)` вернул бы пары «проповедник + книга», а списки должны быть независимыми.
- Каждый запрос фильтрует на уровне SQL: `IS NOT NULL` и `btrim(..., E' \t\n\r') <> ''` — NULL и пустые/пробельные значения (включая табы и переводы строк) не попадают в ответ.
- Порядок — **алфавитный**, задан `ORDER BY ... ASC` в SQL (детерминированный).
- Маршрут **публичный** (как `findAll`); объявлен **до** `@Get(':id')` — иначе статический сегмент `distinct-values` был бы перехвачен параметром `:id`.

## `create` (SERIALIZABLE) и привязка к плейлистам

- `create` сохраняет проповедь, затем `attachSermonToPlaylists(savedSermon, playlistsIds)`.
- Привязка к плейлистам — **SERIALIZABLE**-транзакция: для каждого плейлиста `max(position)`, новая позиция `(max ?? -1) + 1` — защита от конкурентных дублей позиций.
- **`description: null` → `''`.** Схема `SermonControllerCreateBody` допускает `description: null` (`zod.string().nullable()`), но колонка `sermon.description` в БД — `NOT NULL` (см. [`../db.md`](../db.md), `sql/bootstrap.sql`), поэтому сервис приводит `null` к пустой строке на границе: `description: dto.description ?? ''`. Иначе INSERT с `NULL` падал бы HTTP 500 (нарушение not-null constraint).

## `update` и `syncSermonPlaylistMembership`

- `update` строит `updateFields` только из заданных полей (по `!== undefined`) и `sermonRepository.update(id, updateFields)`.
- Если `description` задан и равен `null` — то же приведение, что в `create`: `updateFields.description = dto.description ?? ''` (UPDATE с `NULL` нарушил бы `NOT NULL` так же, как INSERT).
- `update` дополнительно проверяет **эффективные** `chapter`/`verse` (присутствующий в запросе ключ, иначе — сохранённое значение): комбинация, валидная в рамках одного запроса, но недопустимая для сохранённого состояния (диапазон глав + не-null не-диапазонный стих), возвращает 400 с тем же сообщением, что и DTO.
- Затем `syncSermonPlaylistMembership(existingSermon, playlistsIds)`: разница текущих join-ов и желаемого набора — удаляет лишние, добавляет недостающие (`attachSermonToPlaylists`). Возвращает `{ status: 'success' }`.

## `remove`

Удаляет строку из БД, затем (best-effort) чистит аудио- и текстовый файлы из MinIO через `MinioService.removeObjectByName`. URL читаются до удаления строки (пока запись ещё существует).

`audioUrl`/`textFileUrl` приходят от клиента (схема проверяет только префикс пути `/files/`, host любой), поэтому перед удалением объекта действуют защитные проверки — иначе модератор мог бы прописать в проповедь ссылку на чужое аудио или обложку и удалением проповеди стереть этот файл:

- имя объекта (`extractFileNameFromUrl`) должно совпадать с `STORED_FILE_NAME_PATTERN` (`<uuid>.<ext>` — только наши загрузки);
- расширение должно соответствовать полю: `audioUrl` → `AUDIO_EXTENSIONS` (`.mp3/.m4a`), `textFileUrl` → `TEXT_EXTENSIONS` (`.pdf/.fb2`) — обложку через эти поля не удалить;
- объект не должен упоминаться ни в одной оставшейся проповеди или плейлисте (любая из колонок `audioUrl`/`textFileUrl`/`artwork`): referenced-наборы строятся через общий `collectReferencedFileNames` **после** удаления строки.

Не прошедший проверку объект остаётся в bucket (в лог пишется причина) — позже его подберёт orphans-cleanup, если он действительно ни к чему не привязан. Любой сбой очистки — файл не найден, невалидный/чужой URL, MinIO недоступен — логируется как `WARN` и не валит HTTP-запрос: БД остаётся источником истины. Ответ: `{ status: 'success' }`.

## DTO

| Файл | Схема |
|------|-------|
| `src/sermon/dto/create-sermon.dto.ts` | `SermonControllerCreateBody` + `.superRefine(...)` — cross-field правило «глава-диапазон» |
| `src/sermon/dto/update-sermon.dto.ts` | `SermonControllerUpdateBody` + `.superRefine(...)` — то же правило |
| `src/sermon/dto/find-all-sermons-query.dto.ts` | extends query + `.extend({ take: z.coerce.number().int().min(1).max(100).optional(), search: z.string().trim().min(1).max(200).optional(), cursor: z.string().min(1).optional(), page: z.coerce.number().int().min(1).max(100000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), sort: z.enum(['date','title','artist','playlist']).optional(), order: z.enum(['asc','desc']).optional() })` + `.superRefine(...)` — взаимоисключение `page`/`limit` с `take`/`cursor` + взаимоисключение `sort`/`order` с `take`/`cursor` + `.transform(...)` — резолв направленных дефолтов `sort`/`order` |
| `src/sermon/dto/sermon-response.dto.ts` | create/findOne |
| `src/sermon/dto/all-sermons-response.dto.ts` | findAll |
| `src/sermon/dto/distinct-values-response.dto.ts` | distinct-values |
| `src/sermon/dto/status-sermon-response.dto.ts` | update/remove |

> ✅ Входные схемы `create`/`update` ограничены: `title` ≤ 300, `description` ≤ 10000, `artist` ≤ 200, `book` ≤ 100, `artwork` ≤ 2048 и пустая строка либо `http(s)://`-ссылка, `playlistsIds` ≤ 1000. `textFileUrl`/`audioUrl` — `format: uri`, ≤ 2048 и путь начинается с `/files/` (любой host; nullable сохранён), `youtubeUrl` — `http(s)://`-URL ≤ 2048. Схемы `javascript:`/`data:` в `youtubeUrl`/`artwork` отклоняются (защита от stored XSS: клиенты выводят эти значения в `href`/`src`). Ответы ограничений не несут (legacy-строки должны сериализоваться). Полная таблица — [`../contracts/rest-api.md`](../contracts/rest-api.md).

> ✅ **Cross-field правило «глава-диапазон»** (OpenAPI 0.13.0): `chapter` — `integer | [integer, integer] | null`; `verse` — `integer | [integer, integer] | (integer | [integer, integer])[] | null` (список разрозненных отрезков, например `[[9,18],20]`). Диапазон глав (`chapter: [3, 4]`) обязан сочетаться с диапазоном стихов (`verse: [16, 2]`) или отсутствием стиха (`verse: null`) — одиночный стих (`verse: 16`) и список отрезков (`verse: [[9,18],20]`) не могут быть привязаны к диапазону глав (отрезки имеют смысл только внутри одной главы). Оба DTO (`create`/`update`) навешивают `.superRefine(...)` на сгенерированную схему: `Array.isArray(chapter) && verse !== undefined && verse !== null && !isVerseRange(verse)` → ошибка `'verse must be a two-integer range or null when chapter is a range'` по пути `verse`. `chapter`/`verse` — **необязательные** ключи (book-only ссылка валидна): отсутствующий ключ в `create` нормализуется в `null` на границе сервиса, в `update` — означает «не менять поле». Правило продублировано в сервисе: `update()` проверяет **эффективные** значения (присутствующий ключ, иначе сохранённое) — дыра «cross-request» (PATCH меняет стих, не трогая главу) закрыта на сервисном уровне. **Неоднозначность на проводе:** массив из ровно двух целых чисел всегда трактуется как диапазон — список отрезков из двух одиночных стихов неотличим от диапазона, поэтому клиенты оборачивают одиночные стихи как `[n,n]` (`[[9,9],[20,20]]`). Сгенерированная схема не переписывается — правило добавляется поверх (см. [`../validation-pipeline.md`](../validation-pipeline.md)).

> ✅ `find-all-sermons-query.dto.ts` — канонический пример **extend/override** DTO: переопределяет `take` (string→number coercion), `search` (trim + reject empty), `cursor` (сгенерированный `zod.uuid()` → непрозрачная непустая строка: формат курсора зависит от режима — `{rank, id}` при поиске, `{createdAt, id}` без поиска — и проверяется в сервисе, поэтому DTO не дублирует формат) и добавляет `page`/`limit` (string→number coercion). `sort`/`order` переопределяются в `.optional()` (сгенерированные схемы несут `zod.default` `date`/`desc`): дефолт делал бы ключ всегда присутствующим — тогда правило конфликта срабатывало бы на каждом `take`/`cursor`-запросе, а направленный дефолт (`asc` для алфавитных сортировок) нельзя было бы отличить от явного `desc`; оба резолвятся в `.transform` (направление читает **резолвленный** `sort`, поэтому отсутствующий `sort` даёт `date`/`desc`). `superRefine` отклоняет `page`/`limit` вместе с `take`/`cursor` (`'page and limit are mutually exclusive with take and cursor'`) и `sort`/`order` вместе с `take`/`cursor` (`'sort and order are mutually exclusive with take and cursor'`). Подробнее — [`../conventions.md`](../conventions.md).

## Связанные документы

- [README.md](./README.md) — индекс модулей
- [playlist.md](./playlist.md) — плейлисты и join-таблица `playlist_sermons_sermon`
- [minio.md](./minio.md) — `removeObjectByName`, `extractFileNameFromUrl`, `collectReferencedFileNames`
- [shared.md](./shared.md) — `IdParamDto`
- [../db.md](../db.md) — сущность и связи
- [../contracts/rest-api.md](../contracts/rest-api.md) — контракт `SermonController*`
- Домен sermons на фронте — репозиторий `slovo-propovedi-admin`
