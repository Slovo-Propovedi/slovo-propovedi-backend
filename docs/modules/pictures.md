# Модуль `pictures` — BlurHash обложек

Хранит BlurHash-плейсхолдеры загруженных изображений: компактную строку, которую клиент показывает, пока грузится оригинал обложки. Значение считается при загрузке картинки через `POST /files` и лежит в таблице `picture`; в каталоговых ответах оно едет рядом с `artwork` в поле `artworkBlurhash` (у `GET /files` контракт не менялся).

**Слой:** backend (module `pictures`)
**Статус:** актуально

## Назначение

- Для каждого загруженного изображения (`.jpeg/.jpg/.png/.webp`) считается BlurHash и сохраняется вместе с именем объекта в бакете `files`.
- Строка дешёвая (несколько десятков байт), поэтому клиент может отдавать её до загрузки самой обложки и показывать размытую заглушку без отдельного запроса.
- Существующие картинки дозаполняются скриптом `npm run backfill-blurhash` (см. ниже).
- REST-контракт `GET /files`/`POST /files` **не менялся**: `FileResponseDto` остался прежним, blurhash в ответах файловых эндпоинтов не появляется.

## Устройство

```
src/pictures/
├── pictures.module.ts             # TypeOrmModule.forFeature([PictureEntity]) + PicturesService (exported)
├── pictures.service.ts            # record / recordForUpload / findBlurhashes
├── artwork-blurhash.ts            # artworkBlurhashMap(picturesService, urls) — url → blurhash | null
├── blurhash.ts                    # encodeBlurhash / computeBlurhash
└── entities/picture.entity.ts     # PictureEntity (таблица picture)
```

`PicturesModule` подключается в `AppModule`; `PicturesService` экспортируется и внедряется в `AppController` (загрузка файлов), а также в `SermonService`, `PlaylistService` и `SectionService` (обогащение ответов).

### `PictureEntity` — таблица `picture`

`src/pictures/entities/picture.entity.ts`. Полная карта — в [`../db.md`](../db.md).

| Поле | Колонка | Тип | Примечание |
|------|---------|-----|------------|
| `id` | `id` | uuid | PK |
| `picturePath` | `picture-path` | varchar | NOT NULL, **UNIQUE** (`UQ_picture_picture_path`) — имя объекта в бакете `files` (`<uuid>.<ext>`) |
| `blurhash` | `blurhash` | varchar | nullable — BlurHash или `NULL`, если ещё не посчитан |

Уникальность `"picture-path"` — несущая: upsert-семантика сервиса опирается на «не более одной строки на объект».

### `PicturesService`

| Метод | Назначение |
|-------|------------|
| `record(picturePath, blurhash)` | upsert по `"picture-path"`: `findOne` → `save` (обновить `blurhash`) либо `insert` (новая строка). Без TypeORM-опций upsert, чтобы не зависеть от диалекта. |
| `recordForUpload(picturePath, image)` | best-effort: `computeBlurhash(image)` → `record(...)`. Любая ошибка вычисления или записи логируется (`Blurhash for <file> failed: ...`) и **не валит загрузку** — обложка остаётся рабочей, отсутствует только заглушка. |
| `findBlurhashes(picturePaths)` | один батч-запрос `find` по `picture-path IN (...)` с `select { picturePath, blurhash }`; возвращает `Map<picturePath, string \| null>`. Пустой вход сразу даёт пустой `Map` без запроса; отсутствующие пути в `Map` не попадают — вызывающий делает `?? null`. |

`AppController.uploadFile` вызывает `recordForUpload` только для изображений (`MinioService.isImageFile(fileName)`), уже после сохранения объекта в MinIO. Ошибка не меняет ответ `POST /files`.

## Параметры хэширования

`computeBlurhash(image)` (`src/pictures/blurhash.ts`):

```ts
const { data, info } = await sharp(image)
  .rotate()            // применить EXIF-ориентацию (как у превью)
  .ensureAlpha()       // blurhash требует 4 канала (RGBA)
  .raw()
  .toBuffer({ resolveWithObject: true });

encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
```

- `encode` — из пакета `blurhash`; компоненты **4×3** (`x = 4`, `y = 3`) зафиксированы в `encodeBlurhash`. Первый символ строки — size-flag `L` (`(4 − 1) + (3 − 1) × 9 = 21`, 21-й символ base83), по нему клиент понимает размер сетки.
- EXIF-ориентация применяется до чтения пикселей, поэтому заглушка соответствует тому, как клиент показывает оригинал.

## Бэкфилл существующих картинок

Скрипт `scripts/backfill-blurhash.mjs` (`npm run backfill-blurhash`):

- перечисляет бакет `files` рекурсивно и берёт только `.jpeg/.jpg/.png/.webp`;
- пропускает превью `thumbs/` (это производные изображения) и всё вне media-taxonomy;
- читает уже заполненные `picture.blurhash` и не пересчитывает их;
- **dry-run по умолчанию**: печатает `total / skipped / к вычислению` и ничего не скачивает и не пишет;
- с `--apply` последовательно скачивает объект, считает BlurHash и пишет upsert `INSERT ... ON CONFLICT ("picture-path") DO UPDATE SET blurhash = EXCLUDED.blurhash`; ошибки по объекту логируются и не прерывают обход.

Схема таблицы создаётся миграцией [`sql/migrations/016_add_picture.sql`](../../sql/migrations/016_add_picture.sql) (идемпотентна) и продублирована в `sql/bootstrap.sql` для свежих БД.

## BlurHash в ответах каталога

`artwork-blurhash.ts` собирает `Map<artwork URL, blurhash | null>` для нормализаторов ответов:

1. дедуплицирует URL обложек, собранные со всего графа ответа (корневая сущность + вложенные плейлисты/проповеди);
2. достаёт имя объекта через `MinioService.extractFileNameFromUrl` в `try/catch` — непарсящийся или чужой bucket URL молча пропускается (политика [`referenced-files.ts`](../../src/minio/referenced-files.ts): одна битая legacy-строка не должна ломать каталог);
3. делает **один** вызов `findBlurhashes` и возвращает `Map`, ключ — исходный URL, значение — строка BlurHash или `null`.

`SermonService` (`findAll`/`findOne`), `PlaylistService` (`findAll`/`findOne`/`update`) и `SectionService` (`findAll`/`findOne`/`update`) вызывают адаптер один раз на ответ и передают `Map` в нормализаторы. Поле `artworkBlurhash` (`string | null`) добавляется в каждом месте ответа, где есть `artwork`: корневая проповедь/плейлист, плейлист внутри проповеди, проповедь внутри плейлиста/раздела. `null` означает «хэш ещё не посчитан», а не отсутствие обложки; `create` раздела не делает лишнего запроса (пустой `Map`).

## Чего нет (пока)

- Нет HTTP-эндпоинтов модуля: `pictures` — внутренний сервис, наружу торчит только `POST /files`.
- `GET /files` не менялся: blurhash отдаётся только рядом с `artwork` в ответах sermons/playlists/sections, не в файловых DTO.
- Нет удаления строк `picture` при удалении изображения (имена объектов неизменяемы, строки переживают удаление файла; отдельной очистки пока нет).

## Связанные документы

- [README.md](./README.md) — индекс модулей
- [app.md](./app.md) — `POST /files`, из которого вызывается `recordForUpload`
- [minio.md](./minio.md) — загрузка объекта, превью `thumbs/`, таксономия расширений
- [../db.md](../db.md) — таблица `picture` и ручные миграции
- [../../scripts/backfill-blurhash.mjs](../../scripts/backfill-blurhash.mjs) — бэкфилл существующих обложек
