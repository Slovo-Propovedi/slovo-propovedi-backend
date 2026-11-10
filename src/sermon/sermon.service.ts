import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateSermonDto } from './dto/create-sermon.dto';
import { SermonSort } from './dto/find-all-sermons-query.dto';
import { UpdateSermonDto } from './dto/update-sermon.dto';
import { CHAPTER_RANGE_VERSE_MESSAGE, isVerseRange } from './dto/verse-range';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { SermonEntity } from './entities/sermon.entity';
import { PlaylistEntity } from 'src/playlist/entities/playlist.entity';
import { PlaylistSermonJoinEntity } from 'src/playlist/entities/playlist-sermon-join.entity';
import { SectionEntity } from 'src/section/entities/section.entity';
import { SectionPlaylistJoinEntity } from 'src/section/entities/section-playlist-join.entity';
import { DataSource, In, Repository } from 'typeorm';
import {
  AllSermonsResponse,
  DistinctValuesResponse,
  NormalizedSermonResponse,
  StatusSermonResponse,
  UpdateSermon,
} from './interfaces/interface';
import { MinioService, ReferencedFileNames } from 'src/minio/minio.service';
import { artworkBlurhashMap } from 'src/pictures/artwork-blurhash';
import { PicturesService } from 'src/pictures/pictures.service';
import {
  collectReferencedFileNames,
  isReferencedAnywhere,
} from 'src/minio/referenced-files';
import {
  AUDIO_EXTENSIONS,
  getFileExtension,
  STORED_FILE_NAME_PATTERN,
  TEXT_EXTENSIONS,
} from 'src/shared/media';
import { DEFAULT_PAGE_LIMIT } from 'src/shared/pagination';
import { SortOrder } from 'src/shared/sort';
import { toInternalServerError } from 'src/shared/internal-error';

// TypeORM 1.0 dropped the string-array form of `relations`; the object form
// below encodes the same nested relation graph.
const SERMON_RELATIONS = {
  playlistJoins: {
    playlist: {
      sectionJoins: { section: true },
      sermonJoins: {
        sermon: {
          playlistJoins: { playlist: true },
        },
      },
    },
  },
};

// DB-level ordering for the relation paths normalizePlaylistRelations exposes
// — each playlist's section and sermon joins ordered by position, so no
// in-memory re-sorting is needed.
const SERMON_RELATION_ORDER = {
  playlistJoins: {
    position: 'ASC',
    playlist: {
      sectionJoins: { position: 'ASC' },
      sermonJoins: { position: 'ASC' },
    },
  },
} as const;

/**
 * Every artwork URL a normalized sermon response can contain: the root sermon,
 * each of its playlists and each sermon nested inside those playlists. Gathered
 * once per response so the blurhash lookup is a single batched query.
 */
const collectArtworkUrls = (sermons: readonly SermonEntity[]): string[] => {
  const urls: string[] = [];
  for (const sermon of sermons) {
    if (sermon.artwork) {
      urls.push(sermon.artwork);
    }
    for (const playlistJoin of sermon.playlistJoins ?? []) {
      const playlist = playlistJoin.playlist;
      if (playlist.artwork) {
        urls.push(playlist.artwork);
      }
      for (const sermonJoin of playlist.sermonJoins ?? []) {
        if (sermonJoin.sermon.artwork) {
          urls.push(sermonJoin.sermon.artwork);
        }
      }
    }
  }
  return urls;
};

// ---------------------------------------------------------------------------
// Full-text search: boundary parsing + single source of truth for the weights
// ---------------------------------------------------------------------------
//
// Search is word-order-independent AND relevance-ranked via PostgreSQL FTS on
// the generated column sermon.search_vector (sql/migrations/005_sermon_search
// _tsvector.sql): the fields below are folded into the vector once, weighted,
// and both findAll code paths match a tsquery against it and rank with the
// same ts_rank expression.

const TS_CONFIG = 'russian';

// Weighted searchable fields — the single source of truth for what the FTS
// vector indexes and how it ranks. The generated column expression and the
// ts_rank weights are derived from this exact definition.
const SEARCH_WEIGHTS = {
  A: ['title'],
  B: ['artist', 'book'],
  D: ['description'],
} as const;

// Canonical tsvector expression backing sermon.search_vector — must match
// sql/migrations/005_sermon_search_tsvector.sql and sql/bootstrap.sql.
export const buildSearchVectorExpression = (): string =>
  (Object.entries(SEARCH_WEIGHTS) as Array<[string, readonly string[]]>)
    .flatMap(([weight, fields]) =>
      fields.map(
        (field) =>
          `setweight(to_tsvector('${TS_CONFIG}', coalesce(${field}, '')), '${weight}')`,
      ),
    )
    .join(' || ');

// Postgres ts_rank weight array — elements are D, C, B, A in that order, so
// description (D) ranks lowest and title (A) highest; the unused C keeps the
// default 0.2.
const TS_RANK_WEIGHTS = '{0.1,0.2,0.4,1.0}';

// The sanitized token string is bound as :tsquery and parsed by to_tsquery
// (which applies the russian stemmer — a raw text param bound to @@ would NOT
// stem and would miss matches).
const toTsQuerySql = () => `to_tsquery('${TS_CONFIG}', :tsquery)`;

// FTS match condition shared by both code paths.
const TS_SEARCH_CONDITION = `sermon.search_vector @@ ${toTsQuerySql()}`;

// ts_rank expression shared by ORDER BY and the composite cursor comparison —
// the SAME :tsquery parameter is bound in the WHERE clause and here, so a
// row's rank is identical in both places.
const buildRankExpression = (): string =>
  `ts_rank('${TS_RANK_WEIGHTS}'::float4[], sermon.search_vector, ${toTsQuerySql()})`;

// Parse the raw search string at the boundary into a tsquery: keep only word
// characters (letters/digits, incl. Cyrillic), AND every token together so
// word order is irrelevant, and append :* to each token so partial words match
// (благода → благодать). The result is safe to hand to to_tsquery — it
// contains no tsquery syntax characters by construction. Input with no word
// characters at all (e.g. "&&&") fails fast.
// Sanitized tokens are ANDed into one tsquery; each token becomes a lexeme
// lookup, so an unbounded token count is CPU amplification even when the raw
// string is short (e.g. 200 one-character words). The spec bounds the input to
// 200 characters; this cap bounds pathological many-token queries on top of
// that. Rejecting (not truncating) keeps the parsed query faithful to what the
// caller asked for — a silently truncated query would return misleading hits.
const SEARCH_MAX_TOKENS = 40;

const buildSearchTsQuery = (search: string): string => {
  const tokens = search.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) {
    throw new BadRequestException(
      'search must contain at least one word character',
    );
  }
  if (tokens.length > SEARCH_MAX_TOKENS) {
    throw new BadRequestException('Search query is too complex');
  }
  return tokens.map((token) => `${token}:*`).join(' & ');
};
export { buildSearchTsQuery };

// Composite keyset cursor for relevance-ordered pages: the order is
// (rank DESC, id DESC), so a bare id cursor would skip/duplicate rows when
// ranks tie. The cursor is opaque to the client (base64 JSON); old plain-uuid
// cursors are invalidated and fail fast with a clear error.
const encodeCompositeCursor = (rank: number, id: string): string =>
  Buffer.from(JSON.stringify({ rank, id })).toString('base64');

const decodeCompositeCursor = (
  cursor: string,
): { rank: number; id: string } => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    throw new BadRequestException('invalid or stale cursor');
  }
  if (typeof decoded !== 'object' || decoded === null) {
    throw new BadRequestException('invalid or stale cursor');
  }
  const { rank, id } = decoded as { rank?: unknown; id?: unknown };
  if (typeof rank !== 'number' || typeof id !== 'string') {
    throw new BadRequestException('invalid or stale cursor');
  }
  return { rank, id };
};
export { encodeCompositeCursor, decodeCompositeCursor };

// Keyset cursor for date-ordered pages: the sort key is (created_at, id). The
// cursor is opaque (base64 JSON) and carries the entity's JS Date, which has
// millisecond precision — the same precision the ORDER BY uses via
// date_trunc('milliseconds', …), so the bound value equals the sort key BY
// CONSTRUCTION (now() writes microseconds; comparing them raw would silently
// skip rows). Old plain-uuid cursors are invalidated and fail fast.
const ISO_DATE_CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const encodeDateCursor = (createdAt: Date, id: string): string =>
  Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString('base64');

const decodeDateCursor = (
  cursor: string,
): { createdAt: string; id: string } => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    throw new BadRequestException('invalid or stale cursor');
  }
  if (typeof decoded !== 'object' || decoded === null) {
    throw new BadRequestException('invalid or stale cursor');
  }
  const { createdAt, id } = decoded as { createdAt?: unknown; id?: unknown };
  if (
    typeof createdAt !== 'string' ||
    !ISO_DATE_CURSOR_PATTERN.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof id !== 'string'
  ) {
    throw new BadRequestException('invalid or stale cursor');
  }
  return { createdAt, id };
};
export { encodeDateCursor, decodeDateCursor };

@Injectable()
export class SermonService {
  private readonly logger = new Logger(SermonService.name);

  constructor(
    @InjectRepository(SermonEntity)
    private sermonRepository: Repository<SermonEntity>,
    @InjectRepository(PlaylistEntity)
    private playlistRepository: Repository<PlaylistEntity>,
    @InjectRepository(PlaylistSermonJoinEntity)
    private playlistSermonJoinRepository: Repository<PlaylistSermonJoinEntity>,
    @InjectRepository(SectionEntity)
    private sectionRepository: Repository<SectionEntity>,
    @InjectRepository(SectionPlaylistJoinEntity)
    private sectionPlaylistJoinRepository: Repository<SectionPlaylistJoinEntity>,
    private readonly minioService: MinioService,
    private readonly picturesService: PicturesService,
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  async create(
    createSermonDto: CreateSermonDto,
  ): Promise<NormalizedSermonResponse> {
    try {
      const sermon = this.sermonRepository.create({
        title: createSermonDto.title,
        // The schema allows `description: null`, but the DB column is NOT NULL —
        // coerce null to '' at the boundary so an INSERT can never violate it.
        description: createSermonDto.description ?? '',
        audioUrl: createSermonDto.audioUrl,
        youtubeUrl: createSermonDto.youtubeUrl,
        textFileUrl: createSermonDto.textFileUrl,
        artist: createSermonDto.artist,
        artwork: createSermonDto.artwork,
        book: createSermonDto.book,
        // chapter/verse are optional in the schema — an absent key must still
        // land as an explicit NULL in the column, not an omitted INSERT field.
        chapter: createSermonDto.chapter ?? null,
        verse: createSermonDto.verse ?? null,
      });
      const savedSermon = await this.sermonRepository.save(sermon);
      await this.attachSermonToPlaylists(
        savedSermon,
        createSermonDto.playlistsIds,
      );
      return await this.findOne(savedSermon.id);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'createSermon', error);
    }
  }

  async findAll(
    take?: number,
    cursor?: string,
    search?: string,
    page?: number,
    limit?: number,
    sort: SermonSort = 'date',
    order?: SortOrder,
  ): Promise<AllSermonsResponse> {
    try {
      // Parse the search term at the boundary ONCE: the sanitized tsquery
      // drives the WHERE condition and the ORDER BY ranking in both paths.
      const tsquery = search ? buildSearchTsQuery(search) : undefined;

      // Offset mode is selected by the presence of page/limit (limit without
      // page means page 1). The DTO rejects page combined with take/cursor,
      // so the service never sees an ambiguous combination.
      const offsetMode = page !== undefined || limit !== undefined;

      // The DTO resolves the direction default (desc for date, asc for the
      // alphabetical sorts); the same rule is the service fallback for direct
      // callers.
      const direction: SortOrder = order ?? (sort === 'date' ? 'desc' : 'asc');

      // Relevance-ranked search orders by (rank DESC, id DESC) and IGNORES
      // sort/order — the spec: «при поиске сортировка игнорируется». Without
      // search the plain sort orders apply (date sorts by created_at with an
      // id tiebreaker; the keyset cursor carries that same pair).
      const primaryOrders: Array<
        [
          order: string,
          direction: 'ASC' | 'DESC',
          nulls?: 'NULLS FIRST' | 'NULLS LAST',
        ]
      > = tsquery
        ? [
            ['rank', 'DESC'],
            ['sermon.id', 'DESC'],
          ]
        : this.buildSortOrders(sort, direction);

      // sort=playlist pages the PARENT ids first: a sermon can belong to
      // several playlists, so a join in the page query would multiply rows
      // and under-fill pages. The ids are ordered by the first-position
      // playlist title and the page is hydrated afterwards.
      if (offsetMode && !tsquery && sort === 'playlist') {
        return await this.findSermonsOffsetPageByPlaylist(
          page,
          limit,
          direction,
        );
      }

      // Page query: sermons only, no relation joins. The relation graph is
      // assembled afterwards from linear queries (assembleSermonGraph) — the
      // former 8-level leftJoinAndSelect chain produced a cartesian row
      // explosion on GET /sermons that OOM-killed the production container.
      const pageQueryBuilder =
        this.sermonRepository.createQueryBuilder('sermon');

      if (tsquery) {
        pageQueryBuilder
          .addSelect(buildRankExpression(), 'rank')
          .where(TS_SEARCH_CONDITION)
          .setParameter('tsquery', tsquery);
      }

      // sort=playlist orders by the top-level playlist title via a plain
      // (non-select) join. Only the full-fetch id-page paths can reach this
      // state — the DTO rejects sort/order combined with take/cursor, and the
      // offset id-page path above returns early — so the join never multiplies
      // entity rows. getMany groups by primary key anyway, so each sermon
      // appears exactly once even when it belongs to several playlists.
      if (!tsquery && sort === 'playlist') {
        pageQueryBuilder
          .leftJoin('sermon.playlistJoins', 'playlistSermonJoin')
          .leftJoin('playlistSermonJoin.playlist', 'playlist');
      }

      // orderBy replaces any previous order, addOrderBy appends — apply the
      // primary orders first (relation orders are irrelevant now: each sermon
      // row appears exactly once).
      primaryOrders.forEach(([orderExpr, orderDirection, nulls], index) => {
        if (index === 0) {
          if (nulls) {
            pageQueryBuilder.orderBy(orderExpr, orderDirection, nulls);
          } else {
            pageQueryBuilder.orderBy(orderExpr, orderDirection);
          }
        } else if (nulls) {
          pageQueryBuilder.addOrderBy(orderExpr, orderDirection, nulls);
        } else {
          pageQueryBuilder.addOrderBy(orderExpr, orderDirection);
        }
      });

      if (offsetMode) {
        // Offset pagination: skip/take over the same join-free page query.
        // count is the TOTAL number of matching sermons (same cheap getCount
        // as the full fetch), and there is no cursor — the client pages by
        // number.
        const effectivePage = page ?? 1;
        const effectiveLimit = limit ?? DEFAULT_PAGE_LIMIT;
        pageQueryBuilder
          .skip((effectivePage - 1) * effectiveLimit)
          .take(effectiveLimit);
        const sermons = await pageQueryBuilder.getMany();
        const count = await this.countSermons(tsquery);
        const graph = await this.assembleSermonGraph(sermons);
        return {
          sermons: await this.normalizeSermonGraph(graph),
          count,
          nextCursor: null,
        };
      }

      if (!take) {
        // Backward-compatible full fetch — used by the admin UI when no
        // pagination params are supplied. When search is present it is ranked
        // by relevance like the keyset path; the response shape is unchanged.
        const sermons = await pageQueryBuilder.getMany();
        const count = await this.countSermons(tsquery);
        const graph = await this.assembleSermonGraph(sermons);
        return {
          sermons: await this.normalizeSermonGraph(graph),
          count,
          nextCursor: null,
        };
      }

      // Keyset (cursor) pagination: instead of OFFSET — which rescans and skips
      // every row before the offset on each page — fetch take+1 rows after the
      // cursor and use the extra row to decide whether another page exists.
      if (tsquery) {
        if (cursor) {
          // Relevance pages are ordered by (rank DESC, id DESC), so a bare id
          // cursor is wrong — the composite cursor carries both values and
          // paginates with a row-value comparison. The rank is float4 in the
          // DB; the bound JS number is float8, so cast it back to float4 for
          // an exact (not approximate) comparison.
          const { rank, id } = decodeCompositeCursor(cursor);
          pageQueryBuilder.andWhere(
            `(${buildRankExpression()}, sermon.id) < (:rank::float4, :id)`,
            { rank, id },
          );
        }
      } else if (cursor) {
        // Date-ordered pages are the only non-search keyset mode, so the
        // cursor carries (created_at, id). The comparison uses the SAME
        // date_trunc('milliseconds', …) expression as the ORDER BY plus the id
        // tiebreaker, so a tie on the timestamp cannot skip or duplicate rows.
        // Both directions are handled: the service receives the resolved sort
        // direction for direct callers too.
        const { createdAt, id } = decodeDateCursor(cursor);
        const op = direction === 'asc' ? '>' : '<';
        pageQueryBuilder.andWhere(
          `(date_trunc('milliseconds', sermon.created_at), sermon.id) ${op} (:createdAt::timestamptz, :id)`,
          { createdAt, id },
        );
      }

      pageQueryBuilder.take(take + 1);

      // The search path selects the rank expression (for the composite cursor)
      // and reads it back from the raw rows; the no-search path needs no extra
      // select and can stay on the plain getMany.
      const rawAndEntities = tsquery
        ? await pageQueryBuilder.getRawAndEntities()
        : undefined;
      const rows = rawAndEntities
        ? rawAndEntities.entities
        : await pageQueryBuilder.getMany();
      const hasMore = rows.length > take;
      const sermons = hasMore ? rows.slice(0, take) : rows;

      let nextCursor: string | null = null;
      if (hasMore) {
        const lastSermon = sermons[sermons.length - 1];
        if (tsquery) {
          const lastRaw = rawAndEntities.raw.find(
            (row) => row.sermon_id === lastSermon.id,
          );
          if (!lastRaw) {
            throw new Error(
              `rank row for sermon "${lastSermon.id}" missing from search results`,
            );
          }
          nextCursor = encodeCompositeCursor(
            Number(lastRaw.rank),
            lastSermon.id,
          );
        } else {
          nextCursor = encodeDateCursor(lastSermon.createdAt, lastSermon.id);
        }
      }

      const graph = await this.assembleSermonGraph(sermons);
      return {
        sermons: await this.normalizeSermonGraph(graph),
        count: null,
        nextCursor,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findAllSermonItems', error);
    }
  }

  // ORDER BY expressions for the non-search sort keys. The direction is the
  // resolved default from the DTO (asc for the alphabetical sorts, desc for
  // date); the tiebreak is id so equal keys stay deterministic (direction-
  // aware for date, since the cursor comparison follows the same direction).
  // date orders by created_at truncated to milliseconds — the exact precision
  // of the JS Date carried in the keyset cursor — with id as the tiebreaker.
  // playlist bases the order on the LOWEST-position playlist title with
  // NULLS LAST (sermons without playlists stay at the end in both directions)
  // and then the join position within that playlist.
  private buildSortOrders(
    sort: SermonSort,
    direction: SortOrder,
  ): Array<
    [
      order: string,
      direction: 'ASC' | 'DESC',
      nulls?: 'NULLS FIRST' | 'NULLS LAST',
    ]
  > {
    const dir = direction === 'asc' ? 'ASC' : 'DESC';
    switch (sort) {
      case 'title':
        return [
          ['LOWER(sermon.title)', dir],
          ['sermon.id', 'DESC'],
        ];
      case 'artist':
        return [
          ['LOWER(sermon.artist)', dir],
          ['sermon.id', 'DESC'],
        ];
      case 'playlist':
        return [
          ['LOWER(playlist.title)', dir, 'NULLS LAST'],
          ['playlistSermonJoin.position', dir],
          ['sermon.id', 'DESC'],
        ];
      case 'date':
        return [
          [`date_trunc('milliseconds', sermon.created_at)`, dir],
          ['sermon.id', dir],
        ];
    }
  }

  // Offset page for sort=playlist: pages the PARENT ids (GROUP BY sermon.id —
  // one row per sermon even when a sermon belongs to several playlists),
  // orders by the lowest-position playlist title (NULLS LAST) and then by the
  // minimum join position, and hydrates the page by ids. A missing row means
  // a dangling FK — fail fast instead of silently dropping it.
  private async findSermonsOffsetPageByPlaylist(
    page: number | undefined,
    limit: number | undefined,
    direction: SortOrder,
  ): Promise<AllSermonsResponse> {
    const effectivePage = page ?? 1;
    const effectiveLimit = limit ?? DEFAULT_PAGE_LIMIT;
    const dir = direction === 'asc' ? 'ASC' : 'DESC';

    const idQueryBuilder = this.sermonRepository
      .createQueryBuilder('sermon')
      .select('sermon.id', 'id')
      .leftJoin('sermon.playlistJoins', 'playlistSermonJoin')
      .leftJoin('playlistSermonJoin.playlist', 'playlist')
      .groupBy('sermon.id')
      .orderBy('MIN(LOWER(playlist.title))', dir, 'NULLS LAST')
      .addOrderBy('MIN(playlistSermonJoin.position)', dir)
      .addOrderBy('sermon.id', 'DESC')
      .skip((effectivePage - 1) * effectiveLimit)
      .take(effectiveLimit);
    const idRows = await idQueryBuilder.getRawMany<{ id: string }>();
    const pageIds = idRows.map((row) => row.id);

    const count = await this.countSermons(undefined);

    const sermons = pageIds.length
      ? await this.sermonRepository.find({ where: { id: In(pageIds) } })
      : [];
    const sermonsById = new Map(sermons.map((sermon) => [sermon.id, sermon]));
    const orderedSermons = pageIds.map((id) => {
      const sermon = sermonsById.get(id);
      if (!sermon) {
        throw new Error(`Sermon "${id}" missing from hydration query`);
      }
      return sermon;
    });

    const graph = await this.assembleSermonGraph(orderedSermons);
    return {
      sermons: await this.normalizeSermonGraph(graph),
      count,
      nextCursor: null,
    };
  }

  // Cheap total for the full-fetch response: COUNT over the sermon table
  // (search filter applied when present) instead of getManyAndCount over the
  // join explosion — both count distinct sermon ids, so the value is identical.
  private async countSermons(tsquery?: string): Promise<number> {
    const countQueryBuilder =
      this.sermonRepository.createQueryBuilder('sermon');
    if (tsquery) {
      countQueryBuilder
        .where(TS_SEARCH_CONDITION)
        .setParameter('tsquery', tsquery);
    }
    return await countQueryBuilder.getCount();
  }

  /**
   * Assembles the relation graph for a page of sermons with linear queries and
   * in-memory joins, replacing the former deep leftJoinAndSelect chain (whose
   * cartesian row explosion OOM-killed the 256MB production container).
   *
   * Query set per page:
   *   1. playlist_sermons WHERE sermonId IN (page)      — top-level playlists
   *   2. playlists WHERE id IN (page playlists)
   *   3. playlist_sermons WHERE playlistId IN (playlists) — each playlist's
   *      full sermon list, including sermons not on the page
   *   4. sermons WHERE id IN (off-page nested sermons)
   *   5. playlist_sermons WHERE sermonId IN (involved)  — nested playlists of
   *      every involved sermon (skipped for full-fetch: every sermon is on the
   *      page, so query 1 already contains every link)
   *   6. playlists (id, title) WHERE id IN (nested playlists)
   *   7. section_playlists WHERE playlistId IN (playlists)
   *   8. sections WHERE id IN (involved sections)
   *
   * The returned hydrated graph feeds the SAME normalizeSermonRelations /
   * normalizePlaylistRelations shape builders as the join query did, so the
   * response JSON is byte-for-byte unchanged. Missing related rows fail fast
   * (they indicate corrupted FK data, not an empty result).
   *
   * The read is not snapshot-atomic: a concurrent FK-cascade DELETE between
   * query 1 and query 2 can surface a dangling join and fail fast with a 500
   * instead of returning stale data. Accepted trade-off at admin-scale traffic
   * (milliseconds window); the REPEATABLE READ transaction remedy is tracked
   * in docs/debt.md.
   */
  private async assembleSermonGraph(
    sermons: SermonEntity[],
  ): Promise<SermonEntity[]> {
    if (!sermons.length) {
      return [];
    }

    const pageSermonIds = sermons.map((sermon) => sermon.id);

    const pageSermonJoins = await this.playlistSermonJoinRepository
      .createQueryBuilder('playlistSermonJoin')
      .where('playlistSermonJoin.sermonId IN (:...pageSermonIds)', {
        pageSermonIds,
      })
      .orderBy('playlistSermonJoin.position', 'ASC')
      .addOrderBy('playlistSermonJoin.id', 'ASC')
      .getMany();

    const playlistIds = this.uniqueIds(
      pageSermonJoins.map((join) => join.playlistId),
    );
    const playlists = playlistIds.length
      ? await this.playlistRepository.find({ where: { id: In(playlistIds) } })
      : [];

    const playlistSermonJoins = playlistIds.length
      ? await this.playlistSermonJoinRepository
          .createQueryBuilder('playlistSermonJoin')
          .where('playlistSermonJoin.playlistId IN (:...playlistIds)', {
            playlistIds,
          })
          .orderBy('playlistSermonJoin.position', 'ASC')
          .addOrderBy('playlistSermonJoin.id', 'ASC')
          .getMany()
      : [];

    const pageSermonIdSet = new Set(pageSermonIds);
    const deepSermonIds = this.uniqueIds(
      playlistSermonJoins.map((join) => join.sermonId),
    ).filter((id) => !pageSermonIdSet.has(id));
    const deepSermons = deepSermonIds.length
      ? await this.sermonRepository.find({ where: { id: In(deepSermonIds) } })
      : [];

    const allSermonIds = [...pageSermonIds, ...deepSermonIds];
    const nestedPlaylistJoins = deepSermonIds.length
      ? await this.playlistSermonJoinRepository
          .createQueryBuilder('playlistSermonJoin')
          .where('playlistSermonJoin.sermonId IN (:...allSermonIds)', {
            allSermonIds,
          })
          .orderBy('playlistSermonJoin.position', 'ASC')
          .addOrderBy('playlistSermonJoin.id', 'ASC')
          .getMany()
      : pageSermonJoins;

    const nestedPlaylistIds = this.uniqueIds(
      nestedPlaylistJoins.map((join) => join.playlistId),
    );
    const nestedPlaylists = nestedPlaylistIds.length
      ? await this.playlistRepository.find({
          select: { id: true, title: true },
          where: { id: In(nestedPlaylistIds) },
        })
      : [];

    const sectionJoins = playlistIds.length
      ? await this.sectionPlaylistJoinRepository
          .createQueryBuilder('sectionPlaylistJoin')
          .where('sectionPlaylistJoin.playlistId IN (:...playlistIds)', {
            playlistIds,
          })
          .orderBy('sectionPlaylistJoin.position', 'ASC')
          .addOrderBy('sectionPlaylistJoin.id', 'ASC')
          .getMany()
      : [];
    const sectionIds = this.uniqueIds(
      sectionJoins.map((join) => join.sectionId),
    );
    const sections = sectionIds.length
      ? await this.sectionRepository.find({ where: { id: In(sectionIds) } })
      : [];

    const playlistsById = new Map(
      playlists.map((playlist) => [playlist.id, playlist]),
    );
    const sectionsById = new Map(
      sections.map((section) => [section.id, section]),
    );
    const sermonsById = new Map(
      [...sermons, ...deepSermons].map((sermon) => [sermon.id, sermon]),
    );
    const nestedPlaylistsById = new Map(
      nestedPlaylists.map((playlist) => [playlist.id, playlist]),
    );

    const joinsBySermonId = this.groupJoinsBy(pageSermonJoins, 'sermonId');
    const joinsByPlaylistId = this.groupJoinsBy(
      playlistSermonJoins,
      'playlistId',
    );
    const nestedJoinsBySermonId = this.groupJoinsBy(
      nestedPlaylistJoins,
      'sermonId',
    );
    const sectionJoinsByPlaylistId = this.groupJoinsBy(
      sectionJoins,
      'playlistId',
    );

    return sermons.map((sermon) => ({
      ...sermon,
      playlistJoins: (joinsBySermonId.get(sermon.id) ?? []).map((join) => {
        const playlist = playlistsById.get(join.playlistId);
        if (!playlist) {
          throw new Error(
            `Playlist "${join.playlistId}" of sermon "${sermon.id}" not found`,
          );
        }
        return {
          ...join,
          playlist: {
            ...playlist,
            sectionJoins: (sectionJoinsByPlaylistId.get(playlist.id) ?? []).map(
              (sectionJoin) => {
                const section = sectionsById.get(sectionJoin.sectionId);
                if (!section) {
                  throw new Error(
                    `Section "${sectionJoin.sectionId}" of playlist "${playlist.id}" not found`,
                  );
                }
                return { ...sectionJoin, section };
              },
            ),
            sermonJoins: (joinsByPlaylistId.get(playlist.id) ?? []).map(
              (sermonJoin) => {
                const nestedSermon = sermonsById.get(sermonJoin.sermonId);
                if (!nestedSermon) {
                  throw new Error(
                    `Sermon "${sermonJoin.sermonId}" of playlist "${playlist.id}" not found`,
                  );
                }
                return {
                  ...sermonJoin,
                  sermon: {
                    ...nestedSermon,
                    playlistJoins: (
                      nestedJoinsBySermonId.get(nestedSermon.id) ?? []
                    ).map((nestedJoin) => {
                      const nestedPlaylist = nestedPlaylistsById.get(
                        nestedJoin.playlistId,
                      );
                      if (!nestedPlaylist) {
                        throw new Error(
                          `Playlist "${nestedJoin.playlistId}" of sermon "${nestedSermon.id}" not found`,
                        );
                      }
                      return { ...nestedJoin, playlist: nestedPlaylist };
                    }),
                  },
                };
              },
            ),
          },
        };
      }),
    }));
  }

  private uniqueIds(ids: string[]): string[] {
    return [...new Set(ids)];
  }

  private groupJoinsBy<T extends Record<K, string>, K extends keyof T & string>(
    joins: T[],
    key: K,
  ): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const join of joins) {
      const group = groups.get(join[key]);
      if (group) {
        group.push(join);
      } else {
        groups.set(join[key], [join]);
      }
    }
    return groups;
  }

  // Distinct previously-used artists/books for autocomplete. DISTINCT on two
  // columns together would return value PAIRS, so each column is queried
  // separately; NULL and whitespace-only values are excluded in SQL, and
  // ORDER BY keeps the lists deterministic (alphabetical).
  async getDistinctValues(): Promise<DistinctValuesResponse> {
    try {
      const artistRows = await this.sermonRepository
        .createQueryBuilder('sermon')
        .select('DISTINCT sermon.artist', 'artist')
        .where('sermon.artist IS NOT NULL')
        .andWhere("btrim(sermon.artist, E' \\t\\n\\r') <> ''")
        .orderBy('artist', 'ASC')
        .getRawMany<{ artist: string }>();

      const bookRows = await this.sermonRepository
        .createQueryBuilder('sermon')
        .select('DISTINCT sermon.book', 'book')
        .where('sermon.book IS NOT NULL')
        .andWhere("btrim(sermon.book, E' \\t\\n\\r') <> ''")
        .orderBy('book', 'ASC')
        .getRawMany<{ book: string }>();

      return {
        artists: artistRows.map((row) => row.artist),
        books: bookRows.map((row) => row.book),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'getDistinctValues', error);
    }
  }

  async findOne(id: string): Promise<NormalizedSermonResponse | null> {
    try {
      const sermon = await this.sermonRepository.findOne({
        where: { id },
        relations: SERMON_RELATIONS,
        order: SERMON_RELATION_ORDER,
      });
      if (!sermon) {
        return null;
      }
      const blurhashes = await this.artworkBlurhashesForSermons([sermon]);
      return this.normalizeSermonRelations(sermon, blurhashes);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findOneSermonItem', error);
    }
  }

  async findByIds(ids: string[]): Promise<SermonEntity[]> {
    try {
      if (!ids.length) {
        throw new BadRequestException('ids in empty');
      }
      return await this.sermonRepository.find({ where: { id: In(ids) } });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findByIds sermon', error);
    }
  }

  async update(
    id: string,
    updateSermonDto: UpdateSermonDto,
  ): Promise<StatusSermonResponse> {
    try {
      const existingSermon = await this.sermonRepository.findOne({
        where: { id },
      });
      if (!existingSermon) {
        throw new NotFoundException(`Sermon with id "${id}" not found`);
      }

      const updateFields: UpdateSermon = {};

      if (updateSermonDto.title !== undefined) {
        updateFields.title = updateSermonDto.title;
      }
      if (updateSermonDto.description !== undefined) {
        // Coerce null → '' the same way create does: the DB column is NOT NULL,
        // so an UPDATE with null would violate the constraint.
        updateFields.description = updateSermonDto.description ?? '';
      }
      if (updateSermonDto.audioUrl !== undefined) {
        updateFields.audioUrl = updateSermonDto.audioUrl;
      }
      if (updateSermonDto.textFileUrl !== undefined) {
        updateFields.textFileUrl = updateSermonDto.textFileUrl;
      }
      if (updateSermonDto.youtubeUrl !== undefined) {
        updateFields.youtubeUrl = updateSermonDto.youtubeUrl;
      }
      if (updateSermonDto.artist !== undefined) {
        updateFields.artist = updateSermonDto.artist;
      }
      if (updateSermonDto.artwork !== undefined) {
        updateFields.artwork = updateSermonDto.artwork;
      }
      if (updateSermonDto.book !== undefined) {
        updateFields.book = updateSermonDto.book;
      }
      if (updateSermonDto.chapter !== undefined) {
        updateFields.chapter = updateSermonDto.chapter;
      }
      if (updateSermonDto.verse !== undefined) {
        updateFields.verse = updateSermonDto.verse;
      }

      // The DTO superRefine rule is request-scoped: it only sees the fields
      // present in THIS request, so a PATCH that changes verse while leaving
      // chapter absent (absent = no change) could combine a stored chapter
      // range with a segments verse — a state the DTOs declare impossible.
      // Resolve the EFFECTIVE values (absent → existing stored value; explicit
      // null is a legal "clear" and must flow through) and reject the
      // impossible combination here, before it reaches the DB.
      const effectiveChapter =
        updateFields.chapter !== undefined
          ? updateFields.chapter
          : existingSermon.chapter;
      const effectiveVerse =
        updateFields.verse !== undefined
          ? updateFields.verse
          : existingSermon.verse;

      if (
        Array.isArray(effectiveChapter) &&
        effectiveVerse !== undefined &&
        effectiveVerse !== null &&
        !isVerseRange(effectiveVerse)
      ) {
        throw new BadRequestException(CHAPTER_RANGE_VERSE_MESSAGE);
      }

      await this.sermonRepository.update(id, updateFields);
      await this.syncSermonPlaylistMembership(
        existingSermon,
        updateSermonDto.playlistsIds,
      );
      return { status: 'success' };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'update', error);
    }
  }

  async remove(id: string): Promise<StatusSermonResponse> {
    try {
      // Read the stored file URLs before the row is gone: the DB deletion stays
      // the source of truth and always succeeds; file cleanup is best-effort.
      const sermon = await this.sermonRepository.findOne({ where: { id } });
      await this.sermonRepository.delete(id);

      const candidates: { fileUrl: string; extensions: readonly string[] }[] =
        [];
      if (sermon?.audioUrl) {
        candidates.push({
          fileUrl: sermon.audioUrl,
          extensions: AUDIO_EXTENSIONS,
        });
      }
      if (sermon?.textFileUrl) {
        candidates.push({
          fileUrl: sermon.textFileUrl,
          extensions: TEXT_EXTENSIONS,
        });
      }
      if (!candidates.length) {
        return { status: 'success' };
      }

      // References are loaded AFTER the row is deleted, so they cover only the
      // remaining sermons/playlists: a file another row still points to must
      // survive (audioUrl is free-form, so two sermons may share one object).
      const referenced = await this.loadReferencedFileNames();
      for (const candidate of candidates) {
        await this.removeFileBestEffort(
          candidate.fileUrl,
          candidate.extensions,
          referenced,
        );
      }
      return { status: 'success' };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'remove', error);
    }
  }

  private async loadReferencedFileNames(): Promise<ReferencedFileNames> {
    const [sermons, playlists] = await Promise.all([
      this.sermonRepository.find({
        select: { audioUrl: true, textFileUrl: true, artwork: true },
      }),
      this.playlistRepository.find({ select: { artwork: true } }),
    ]);
    return collectReferencedFileNames(sermons, playlists);
  }

  // Best-effort cleanup of a stored file (audio or text) after the DB row is
  // gone. The stored URL is client-supplied, so the object is deleted only when
  // it is one of OUR uploads of the expected kind (`<uuid>.<ext>` with an
  // audio extension for audioUrl, text for textFileUrl) and no other sermon or
  // playlist still references it — otherwise a crafted URL could wipe another
  // sermon's audio or a cover image. Any failure is logged and swallowed — the
  // HTTP request must never fail because of file cleanup.
  private async removeFileBestEffort(
    fileUrl: string,
    allowedExtensions: readonly string[],
    referenced: ReferencedFileNames,
  ): Promise<void> {
    try {
      const fileName = MinioService.extractFileNameFromUrl(fileUrl);
      if (
        !STORED_FILE_NAME_PATTERN.test(fileName) ||
        !allowedExtensions.includes(getFileExtension(fileName))
      ) {
        this.logger.warn(
          `Skipped removing "${fileUrl}" after sermon deletion: not a stored file of the expected type`,
        );
        return;
      }
      if (isReferencedAnywhere(fileName, referenced)) {
        this.logger.log(
          `Kept "${fileName}" after sermon deletion: still referenced elsewhere`,
        );
        return;
      }
      await this.minioService.removeObjectByName(fileName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to remove file "${fileUrl}" after sermon deletion: ${message}`,
      );
    }
  }

  private async artworkBlurhashesForSermons(
    sermons: readonly SermonEntity[],
  ): Promise<Map<string, string | null>> {
    return artworkBlurhashMap(
      this.picturesService,
      collectArtworkUrls(sermons),
    );
  }

  private async normalizeSermonGraph(
    sermons: SermonEntity[],
  ): Promise<NormalizedSermonResponse[]> {
    const blurhashes = await this.artworkBlurhashesForSermons(sermons);
    return sermons.map((sermon) =>
      this.normalizeSermonRelations(sermon, blurhashes),
    );
  }

  private normalizeSermonRelations(
    sermon: SermonEntity,
    blurhashes: Map<string, string | null>,
  ): NormalizedSermonResponse {
    return {
      id: sermon.id,
      title: sermon.title,
      description: sermon.description,
      textFileUrl: sermon.textFileUrl,
      audioUrl: sermon.audioUrl,
      youtubeUrl: sermon.youtubeUrl,
      artist: sermon.artist,
      artwork: sermon.artwork,
      artworkBlurhash: blurhashes.get(sermon.artwork) ?? null,
      book: sermon.book,
      chapter: sermon.chapter,
      verse: sermon.verse,
      playlists: (sermon.playlistJoins ?? []).map((join) =>
        this.normalizePlaylistRelations(join.playlist, blurhashes),
      ),
      createdAt: sermon.createdAt.toISOString(),
    };
  }

  private normalizePlaylistRelations(
    playlist: PlaylistEntity,
    blurhashes: Map<string, string | null>,
  ): NormalizedSermonResponse['playlists'][number] {
    const sectionJoins = playlist.sectionJoins ?? [];
    const sermonJoins = playlist.sermonJoins ?? [];
    return {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description,
      artwork: playlist.artwork,
      artworkBlurhash: blurhashes.get(playlist.artwork) ?? null,
      sections: sectionJoins.map((sectionJoin) => ({
        id: sectionJoin.section.id,
        title: sectionJoin.section.title,
        description: sectionJoin.section.description,
        position: sectionJoin.section.position,
        itemsSize: sectionJoin.section.itemsSize,
        itemsRows: sectionJoin.section.itemsRows,
        transform: sectionJoin.section.transform,
        isDescriptionTitleOnSlideLarge:
          sectionJoin.section.isDescriptionTitleOnSlideLarge,
        whereIsSlideTitleLocated: sectionJoin.section.whereIsSlideTitleLocated,
        borderRadius: sectionJoin.section.borderRadius,
        playlists: [],
      })),
      sermons: sermonJoins.map((sermonJoin) => ({
        id: sermonJoin.sermon.id,
        title: sermonJoin.sermon.title,
        description: sermonJoin.sermon.description,
        textFileUrl: sermonJoin.sermon.textFileUrl,
        audioUrl: sermonJoin.sermon.audioUrl,
        youtubeUrl: sermonJoin.sermon.youtubeUrl,
        artist: sermonJoin.sermon.artist,
        artwork: sermonJoin.sermon.artwork,
        artworkBlurhash: blurhashes.get(sermonJoin.sermon.artwork) ?? null,
        book: sermonJoin.sermon.book,
        chapter: sermonJoin.sermon.chapter,
        verse: sermonJoin.sermon.verse,
        position: sermonJoin.position,
        playlists: (sermonJoin.sermon.playlistJoins ?? []).map(
          (playlistJoin) => ({
            id: playlistJoin.playlist.id,
            title: playlistJoin.playlist.title,
          }),
        ),
      })),
      createdAt: playlist.createdAt.toISOString(),
    };
  }

  private async attachSermonToPlaylists(
    sermon: SermonEntity,
    playlistIds: string[] | undefined,
  ): Promise<void> {
    if (!playlistIds?.length) {
      return;
    }

    // SERIALIZABLE isolation prevents two concurrent attachments from both
    // reading the same max position and inserting duplicate positions.
    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const joinRepository = manager.getRepository(PlaylistSermonJoinEntity);
      for (const playlistId of playlistIds) {
        const maxPosition = await joinRepository.maximum('position', {
          playlistId,
        });
        await joinRepository.save(
          joinRepository.create({
            playlistId,
            sermonId: sermon.id,
            position: (maxPosition ?? -1) + 1,
          }),
        );
      }
    });
  }

  private async syncSermonPlaylistMembership(
    sermon: SermonEntity,
    desiredPlaylistIds: string[] | undefined,
  ): Promise<void> {
    if (desiredPlaylistIds === undefined) {
      return;
    }

    const currentJoins = await this.playlistSermonJoinRepository.find({
      where: { sermonId: sermon.id },
    });
    const currentPlaylistIds = currentJoins.map((join) => join.playlistId);

    const playlistIdsToRemove = currentPlaylistIds.filter(
      (playlistId) => !desiredPlaylistIds.includes(playlistId),
    );
    if (playlistIdsToRemove.length) {
      await this.playlistSermonJoinRepository.delete({
        sermonId: sermon.id,
        playlistId: In(playlistIdsToRemove),
      });
    }

    const playlistIdsToAdd = desiredPlaylistIds.filter(
      (playlistId) => !currentPlaylistIds.includes(playlistId),
    );
    await this.attachSermonToPlaylists(sermon, playlistIdsToAdd);
  }
}
