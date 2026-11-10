import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatePlaylistDto } from './dto/create-playlist.dto';
import { PlaylistSort } from './dto/find-all-playlists-query.dto';
import { UpdatePlaylistDto } from './dto/update-playlist.dto';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { PlaylistEntity } from './entities/playlist.entity';
import { PlaylistSermonJoinEntity } from './entities/playlist-sermon-join.entity';
import { SectionEntity } from 'src/section/entities/section.entity';
import { SectionPlaylistJoinEntity } from 'src/section/entities/section-playlist-join.entity';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import {
  AllPlaylistsResponse,
  NormalizedPlaylistResponse,
  StatusPlaylistResponse,
} from './interfaces/interface';
import { buildSearchTsQuery, SermonService } from 'src/sermon/sermon.service';
import { artworkBlurhashMap } from 'src/pictures/artwork-blurhash';
import { PicturesService } from 'src/pictures/pictures.service';
import { DEFAULT_PAGE_LIMIT } from 'src/shared/pagination';
import { SortOrder } from 'src/shared/sort';
import { toInternalServerError } from 'src/shared/internal-error';

// TypeORM 1.0 dropped the string-array form of `relations`; the object form
// below encodes the same nested relation graph.
const PLAYLIST_RELATIONS = {
  sermonJoins: {
    sermon: {
      playlistJoins: { playlist: true },
    },
  },
  sectionJoins: { section: true },
};

// DB-level ordering for every relation path the normalize function exposes —
// sermon and section joins are both ordered by position, so no in-memory
// re-sorting is needed. The parent playlist rows are ordered by createdAt
// (property name — TypeORM order keys are entity properties, not columns),
// then id DESC as the deterministic tiebreaker (the same pair as sort=date).
const PLAYLIST_ORDER = {
  createdAt: 'DESC',
  id: 'DESC',
  sermonJoins: { position: 'ASC' },
  sectionJoins: { position: 'ASC' },
} as const;

/**
 * Every artwork URL a normalized playlist response can contain: the playlist
 * itself and each sermon nested inside it. Gathered once per response so the
 * blurhash lookup is a single batched query.
 */
const collectArtworkUrls = (playlists: readonly PlaylistEntity[]): string[] => {
  const urls: string[] = [];
  for (const playlist of playlists) {
    if (playlist.artwork) {
      urls.push(playlist.artwork);
    }
    for (const sermonJoin of playlist.sermonJoins ?? []) {
      if (sermonJoin.sermon.artwork) {
        urls.push(sermonJoin.sermon.artwork);
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
// the generated column playlist.search_vector (sql/migrations/006_playlist
// _search_tsvector.sql): the fields below are folded into the vector once,
// weighted, and the findAll search path matches a tsquery against it and ranks
// with the same ts_rank expression. The raw search string is parsed into a
// tsquery at the boundary by buildSearchTsQuery — shared with the sermon module
// (it throws a BadRequestException for punctuation-only input, which is the
// desired fail-loud behavior).

const TS_CONFIG = 'russian';

// Weighted searchable fields — the single source of truth for what the FTS
// vector indexes and how it ranks. The generated column expression (migration
// 006 + bootstrap) is derived from this exact definition.
const PLAYLIST_SEARCH_WEIGHTS = {
  A: ['title'],
  D: ['description'],
} as const;

// Canonical tsvector expression backing playlist.search_vector — must match
// sql/migrations/006_playlist_search_tsvector.sql and sql/bootstrap.sql.
export const buildPlaylistSearchVectorExpression = (): string =>
  (
    Object.entries(PLAYLIST_SEARCH_WEIGHTS) as Array<
      [string, readonly string[]]
    >
  )
    .flatMap(([weight, fields]) =>
      fields.map(
        (field) =>
          `setweight(to_tsvector('${TS_CONFIG}', coalesce(${field}, '')), '${weight}')`,
      ),
    )
    .join(' || ');

// Postgres ts_rank weight array — elements are D, C, B, A in that order, so
// description (D) ranks lowest and title (A) highest; B and C are unused by
// playlist search (B is the sermon-only artist/book weight, C keeps the
// default 0.2). Same array as the sermon search.
const TS_RANK_WEIGHTS = '{0.1,0.2,0.4,1.0}';

// The sanitized token string is bound as :tsquery and parsed by to_tsquery
// (which applies the russian stemmer — a raw text param bound to @@ would NOT
// stem and would miss matches).
const toTsQuerySql = () => `to_tsquery('${TS_CONFIG}', :tsquery)`;

// FTS match condition for the playlist search path.
const PLAYLIST_TS_SEARCH_CONDITION = `playlist.search_vector @@ ${toTsQuerySql()}`;

// ts_rank expression used by ORDER BY — the SAME :tsquery parameter is bound
// in the WHERE clause and here, so a row's rank matches its filter.
const buildPlaylistRankExpression = (): string =>
  `ts_rank('${TS_RANK_WEIGHTS}'::float4[], playlist.search_vector, ${toTsQuerySql()})`;

@Injectable()
export class PlaylistService {
  private readonly logger = new Logger(PlaylistService.name);

  constructor(
    private sermonService: SermonService,
    @InjectRepository(PlaylistEntity)
    private playlistRepository: Repository<PlaylistEntity>,
    @InjectRepository(SectionEntity)
    private sectionRepository: Repository<SectionEntity>,
    @InjectRepository(SectionPlaylistJoinEntity)
    private sectionPlaylistJoinRepository: Repository<SectionPlaylistJoinEntity>,
    private readonly picturesService: PicturesService,
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  async create(
    createPlaylistDto: CreatePlaylistDto,
  ): Promise<NormalizedPlaylistResponse> {
    try {
      const saved = await this.dataSource.transaction(
        'SERIALIZABLE',
        async (manager) => {
          const playlistRepository = manager.getRepository(PlaylistEntity);
          const playlistSermonJoinRepository = manager.getRepository(
            PlaylistSermonJoinEntity,
          );

          const playlist = playlistRepository.create({
            title: createPlaylistDto.title,
            // The schema allows `description: null`, but the DB column is NOT
            // NULL — coerce null to '' at the boundary so an INSERT can never
            // violate it.
            description: createPlaylistDto.description ?? '',
            artwork: createPlaylistDto.artwork,
            sectionJoins: [],
            sermonJoins: [],
          });
          const saved = await playlistRepository.save(playlist);

          if (createPlaylistDto.sermonsIds?.length) {
            const sermons = await this.sermonService.findByIds(
              createPlaylistDto.sermonsIds,
            );
            if (sermons.length !== createPlaylistDto.sermonsIds.length) {
              throw new NotFoundException('Some sermons not found');
            }
            const joinRows = createPlaylistDto.sermonsIds.map(
              (sermonId, index) =>
                playlistSermonJoinRepository.create({
                  playlistId: saved.id,
                  sermonId,
                  position: index,
                }),
            );
            await playlistSermonJoinRepository.save(joinRows);
          }

          // Mirror of the sermonsIds flow: validation lives inside the
          // transaction, so a throw aborts it and no playlist is persisted.
          if (createPlaylistDto.sectionsIds?.length) {
            if (
              new Set(createPlaylistDto.sectionsIds).size !==
              createPlaylistDto.sectionsIds.length
            ) {
              throw new BadRequestException('Duplicate section IDs detected');
            }
            const sections = await this.sectionRepository.find({
              where: { id: In(createPlaylistDto.sectionsIds) },
            });
            if (sections.length !== createPlaylistDto.sectionsIds.length) {
              throw new NotFoundException('Some sections not found');
            }
          }

          return saved;
        },
      );

      // Attach after the create transaction commits, mirroring the sermon
      // precedent (SermonService.create → attachSermonToPlaylists): the helper
      // opens its own SERIALIZABLE transaction, so it must not run inside this
      // one. Validation above already guaranteed every section exists.
      await this.attachPlaylistToSections(saved, createPlaylistDto.sectionsIds);

      // Re-read after the transactions so the response reflects the fully
      // persisted playlist.
      return await this.findOne(saved.id);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'createPlaylist', error);
    }
  }

  async findAll(
    search?: string,
    page?: number,
    limit?: number,
    sort: PlaylistSort = 'date',
    order?: SortOrder,
  ): Promise<AllPlaylistsResponse> {
    try {
      // Parse the search term at the boundary ONCE: the sanitized tsquery
      // drives the WHERE condition and the ORDER BY ranking. Punctuation-only
      // input fails fast inside buildSearchTsQuery.
      const tsquery = search ? buildSearchTsQuery(search) : undefined;

      // Offset mode is selected by the presence of page/limit (limit without
      // page means page 1). Playlists have no keyset mode, so there is no
      // exclusivity rule to enforce.
      const offsetMode = page !== undefined || limit !== undefined;

      // The DTO resolves the direction default (desc for date, asc for the
      // alphabetical sorts); the same rule is the service fallback for direct
      // callers.
      const direction: SortOrder = order ?? (sort === 'date' ? 'desc' : 'asc');

      if (offsetMode) {
        return await this.findOffsetPage(tsquery, page, limit, sort, direction);
      }

      if (!tsquery) {
        // The default sort (date, desc) keeps the findAndCount path with the
        // deep relation graph and the DB-level join ordering; every other sort
        // goes through the same QueryBuilder the search path uses, with
        // sort-driven parent orders.
        if (sort === 'date' && direction === 'desc') {
          const [playlists, count] = await this.playlistRepository.findAndCount(
            {
              relations: PLAYLIST_RELATIONS,
              order: PLAYLIST_ORDER,
            },
          );
          return {
            playlists: await this.normalizePlaylists(playlists),
            count,
          };
        }

        const queryBuilder = this.buildPlaylistSearchQueryBuilder(
          this.buildPlaylistSortOrders(sort, direction),
        );
        const [playlists, count] = await queryBuilder.getManyAndCount();
        return {
          playlists: await this.normalizePlaylists(playlists),
          count,
        };
      }

      // Relevance-ranked search: (rank DESC, id DESC) followed by the
      // join-position orders, loading the same relation graph findAndCount
      // would. sort/order are ignored per the spec («при поиске сортировка
      // игнорируется»).
      const queryBuilder = this.buildPlaylistSearchQueryBuilder([
        ['rank', 'DESC'],
        ['playlist.id', 'DESC'],
      ]);
      queryBuilder
        .addSelect(buildPlaylistRankExpression(), 'rank')
        .where(PLAYLIST_TS_SEARCH_CONDITION)
        .setParameter('tsquery', tsquery);
      const [playlists, count] = await queryBuilder.getManyAndCount();
      return {
        playlists: await this.normalizePlaylists(playlists),
        count,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findAllPlaylistItems', error);
    }
  }

  // ORDER BY expressions for the non-search sort keys. The direction is the
  // resolved default from the DTO (asc for title/section, desc for date);
  // the tiebreak is always id DESC so equal keys stay deterministic. date
  // orders by created_at truncated to milliseconds (the same precision the
  // sermon keyset cursor uses) with the id tiebreaker.
  // section bases the order on the LOWEST-position section title with
  // NULLS LAST (playlists without sections stay at the end in both
  // directions) and then the join position within that section.
  private buildPlaylistSortOrders(
    sort: PlaylistSort,
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
          ['LOWER(playlist.title)', dir],
          ['playlist.id', 'DESC'],
        ];
      case 'section':
        return [
          ['LOWER(sections.title)', dir, 'NULLS LAST'],
          ['sectionJoins.position', dir],
          ['playlist.id', 'DESC'],
        ];
      case 'date':
        return [
          [`date_trunc('milliseconds', playlist.created_at)`, dir],
          ['playlist.id', 'DESC'],
        ];
    }
  }

  // Offset pagination pages the PARENT ids, not the join query: the former
  // findAndCount-over-joins paginated the cartesian product of the deep
  // relation graph, so a page of N playlists could return fewer than N rows
  // (or duplicate rows) once a playlist held several sermons/sections.
  private async findOffsetPage(
    tsquery: string | undefined,
    page: number | undefined,
    limit: number | undefined,
    sort: PlaylistSort,
    direction: SortOrder,
  ): Promise<AllPlaylistsResponse> {
    const effectivePage = page ?? 1;
    const effectiveLimit = limit ?? DEFAULT_PAGE_LIMIT;
    const dir = direction === 'asc' ? 'ASC' : 'DESC';

    // 1. Page the parent ids only — a join-free query ordered by the sort
    // keys (rank DESC, id DESC under search; created_at DESC, id DESC for the
    // default date sort). The section sort joins section joins but groups by
    // playlist id, so a playlist in several sections still occupies exactly
    // one page row (the lowest-position section title decides its place).
    const idQueryBuilder =
      this.playlistRepository.createQueryBuilder('playlist');
    idQueryBuilder.select('playlist.id', 'id');
    if (tsquery) {
      idQueryBuilder
        .addSelect(buildPlaylistRankExpression(), 'rank')
        .where(PLAYLIST_TS_SEARCH_CONDITION)
        .setParameter('tsquery', tsquery)
        .orderBy('rank', 'DESC')
        .addOrderBy('playlist.id', 'DESC');
    } else if (sort === 'section') {
      idQueryBuilder
        .leftJoin('playlist.sectionJoins', 'sectionJoins')
        .leftJoin('sectionJoins.section', 'sections')
        .groupBy('playlist.id')
        .orderBy('MIN(LOWER(sections.title))', dir, 'NULLS LAST')
        .addOrderBy('MIN(sectionJoins.position)', dir)
        .addOrderBy('playlist.id', 'DESC');
    } else if (sort === 'title') {
      idQueryBuilder
        .orderBy('LOWER(playlist.title)', dir)
        .addOrderBy('playlist.id', 'DESC');
    } else {
      idQueryBuilder
        .orderBy(`date_trunc('milliseconds', playlist.created_at)`, dir)
        .addOrderBy('playlist.id', 'DESC');
    }
    idQueryBuilder
      .skip((effectivePage - 1) * effectiveLimit)
      .take(effectiveLimit);
    const idRows = await idQueryBuilder.getRawMany<{ id: string }>();
    const pageIds = idRows.map((row) => row.id);

    // 2. Total count via a separate lightweight count query (no joins).
    const count = await this.countPlaylists(tsquery);

    // 3. Hydrate the page with the existing relation loading.
    const playlists = pageIds.length
      ? await this.playlistRepository.find({
          where: { id: In(pageIds) },
          relations: PLAYLIST_RELATIONS,
          order: PLAYLIST_ORDER,
        })
      : [];

    // 4. WHERE IN loses the id-page order — restore it in memory. A missing
    // row means a dangling FK (the id page saw it, the hydration did not) —
    // fail fast instead of silently dropping it.
    const playlistsById = new Map(playlists.map((p) => [p.id, p]));
    const orderedPlaylists = pageIds.map((id) => {
      const playlist = playlistsById.get(id);
      if (!playlist) {
        throw new Error(`Playlist "${id}" missing from hydration query`);
      }
      return playlist;
    });

    return {
      playlists: await this.normalizePlaylists(orderedPlaylists),
      count,
    };
  }

  // Cheap total for the offset response: COUNT over the playlist table (search
  // filter applied when present) instead of getManyAndCount over the join
  // explosion — both count distinct playlists, so the value is identical.
  private async countPlaylists(tsquery?: string): Promise<number> {
    const countQueryBuilder =
      this.playlistRepository.createQueryBuilder('playlist');
    if (tsquery) {
      countQueryBuilder
        .where(PLAYLIST_TS_SEARCH_CONDITION)
        .setParameter('tsquery', tsquery);
    }
    return await countQueryBuilder.getCount();
  }

  // QueryBuilder for the deep relation graph path: loads the six
  // PLAYLIST_RELATIONS paths plus the primary ordering (rank DESC, id DESC
  // under search, or the sort-driven orders) followed by the join-position
  // orders normalizePlaylist expects.
  private buildPlaylistSearchQueryBuilder(
    primaryOrders: Array<
      [
        order: string,
        direction: 'ASC' | 'DESC',
        nulls?: 'NULLS FIRST' | 'NULLS LAST',
      ]
    >,
  ): SelectQueryBuilder<PlaylistEntity> {
    const queryBuilder = this.playlistRepository
      .createQueryBuilder('playlist')
      .leftJoinAndSelect('playlist.sermonJoins', 'sermonJoins')
      .leftJoinAndSelect('sermonJoins.sermon', 'sermons')
      .leftJoinAndSelect('sermons.playlistJoins', 'sermonPlaylistJoins')
      .leftJoinAndSelect('sermonPlaylistJoins.playlist', 'sermonPlaylists')
      .leftJoinAndSelect('playlist.sectionJoins', 'sectionJoins')
      .leftJoinAndSelect('sectionJoins.section', 'sections');

    // orderBy replaces any previous order, addOrderBy appends — apply the
    // primary orders first, then the relation orders.
    primaryOrders.forEach(([orderExpr, orderDirection, nulls], index) => {
      if (index === 0) {
        if (nulls) {
          queryBuilder.orderBy(orderExpr, orderDirection, nulls);
        } else {
          queryBuilder.orderBy(orderExpr, orderDirection);
        }
      } else if (nulls) {
        queryBuilder.addOrderBy(orderExpr, orderDirection, nulls);
      } else {
        queryBuilder.addOrderBy(orderExpr, orderDirection);
      }
    });

    return queryBuilder
      .addOrderBy('sermonJoins.position', 'ASC')
      .addOrderBy('sectionJoins.position', 'ASC');
  }

  async findByIds(ids: string[]): Promise<PlaylistEntity[]> {
    try {
      if (!ids.length) {
        throw new BadRequestException('ids in empty');
      }
      return await this.playlistRepository.find({ where: { id: In(ids) } });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findByIds playlist', error);
    }
  }

  async findOne(id: string): Promise<NormalizedPlaylistResponse | null> {
    try {
      const playlist = await this.playlistRepository.findOne({
        where: { id },
        relations: PLAYLIST_RELATIONS,
        order: PLAYLIST_ORDER,
      });
      if (!playlist) {
        return null;
      }
      const blurhashes = await this.artworkBlurhashesForPlaylists([playlist]);
      return this.normalizePlaylist(playlist, blurhashes);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findOnePlaylistItem', error);
    }
  }

  async update(
    id: string,
    updatePlaylistDto: UpdatePlaylistDto,
  ): Promise<NormalizedPlaylistResponse> {
    try {
      const playlist = await this.playlistRepository.findOne({
        where: { id },
        relations: PLAYLIST_RELATIONS,
        order: PLAYLIST_ORDER,
      });

      if (!playlist) {
        throw new NotFoundException('Playlist not found');
      }

      if (updatePlaylistDto.title !== undefined) {
        playlist.title = updatePlaylistDto.title;
      }
      if (updatePlaylistDto.description !== undefined) {
        // Coerce null → '' the same way create does: the DB column is NOT NULL,
        // so an UPDATE with null would violate the constraint.
        playlist.description = updatePlaylistDto.description ?? '';
      }
      if (updatePlaylistDto.artwork !== undefined) {
        playlist.artwork = updatePlaylistDto.artwork;
      }

      await this.playlistRepository.save(playlist);

      if (updatePlaylistDto.sermonsIds !== undefined) {
        await this.replacePlaylistSermons(id, updatePlaylistDto.sermonsIds);
      }

      if (updatePlaylistDto.sectionsIds !== undefined) {
        await this.syncPlaylistSectionMembership(
          playlist,
          updatePlaylistDto.sectionsIds,
        );
      }

      const saved = await this.playlistRepository.findOne({
        where: { id },
        relations: PLAYLIST_RELATIONS,
        order: PLAYLIST_ORDER,
      });
      const normalized = saved ?? playlist;
      const blurhashes = await this.artworkBlurhashesForPlaylists([normalized]);
      return this.normalizePlaylist(normalized, blurhashes);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'update', error);
    }
  }

  async remove(id: string): Promise<StatusPlaylistResponse> {
    try {
      await this.playlistRepository.delete(id);
      return { status: 'success' };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'remove', error);
    }
  }

  async reorderSermonsInPlaylist(
    playlistId: string,
    sermonIds: string[],
  ): Promise<{ status: string }> {
    if (!sermonIds.length) {
      throw new BadRequestException('Sermon IDs array cannot be empty');
    }
    if (new Set(sermonIds).size !== sermonIds.length) {
      throw new BadRequestException('Duplicate sermon IDs detected');
    }

    return this.dataSource.transaction(async (manager) => {
      const playlistRepository = manager.getRepository(PlaylistEntity);
      const playlist = await playlistRepository.findOne({
        where: { id: playlistId },
        select: { id: true },
      });
      if (!playlist) {
        throw new NotFoundException(
          `Playlist with id "${playlistId}" not found`,
        );
      }

      const joinRepository = manager.getRepository(PlaylistSermonJoinEntity);

      // The client must send the complete in-scope set; a partial list would
      // silently collide positions for the omitted sermons.
      const total = await joinRepository.count({ where: { playlistId } });
      if (sermonIds.length !== total) {
        throw new BadRequestException(
          `Reorder list must contain all ${total} items in scope, received ${sermonIds.length}`,
        );
      }

      const joins = await joinRepository.find({
        where: { playlistId, sermonId: In(sermonIds) },
      });
      if (joins.length !== sermonIds.length) {
        throw new NotFoundException('Some sermons are not in the playlist');
      }

      const joinBySermonId = new Map(
        joins.map((join) => [join.sermonId, join]),
      );
      // A single CASE UPDATE replaces the previous per-id loop (N queries).
      // Join ids are UUIDs generated by the DB, so interpolation is safe.
      const positionCase = sermonIds
        .map((sermonId, index) => {
          const join = joinBySermonId.get(sermonId);
          if (!join) {
            throw new NotFoundException(
              `Sermon with id "${sermonId}" is not in the playlist`,
            );
          }
          return `WHEN '${join.id}' THEN ${index}`;
        })
        .join(' ');
      await joinRepository
        .createQueryBuilder()
        .update(PlaylistSermonJoinEntity)
        .set({ position: () => `CASE id ${positionCase} END` })
        .where('id IN (:...ids)', { ids: joins.map((join) => join.id) })
        .execute();

      return { status: 'success' };
    });
  }

  private async replacePlaylistSermons(
    playlistId: string,
    sermonIds: string[],
  ): Promise<void> {
    if (sermonIds.length > 0) {
      const sermons = await this.sermonService.findByIds(sermonIds);
      if (sermons.length !== sermonIds.length) {
        throw new NotFoundException('Some sermons not found');
      }
    }

    // Delete + insert run in one transaction so a failed insert cannot leave
    // the playlist with zero sermons.
    await this.dataSource.transaction(async (manager) => {
      const joinRepository = manager.getRepository(PlaylistSermonJoinEntity);
      await joinRepository.delete({ playlistId });

      if (sermonIds.length === 0) {
        return;
      }

      const joinRows = sermonIds.map((sermonId, index) =>
        joinRepository.create({
          playlistId,
          sermonId,
          position: index,
        }),
      );
      await joinRepository.save(joinRows);
    });
  }

  private async attachPlaylistToSections(
    playlist: PlaylistEntity,
    sectionIds: string[] | undefined,
  ): Promise<void> {
    if (!sectionIds?.length) {
      return;
    }

    // SERIALIZABLE isolation prevents two concurrent attachments from both
    // reading the same max position and inserting duplicate positions.
    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const joinRepository = manager.getRepository(SectionPlaylistJoinEntity);
      for (const sectionId of sectionIds) {
        const maxPosition = await joinRepository.maximum('position', {
          sectionId,
        });
        await joinRepository.save(
          joinRepository.create({
            sectionId,
            playlistId: playlist.id,
            position: (maxPosition ?? -1) + 1,
          }),
        );
      }
    });
  }

  private async syncPlaylistSectionMembership(
    playlist: PlaylistEntity,
    desiredSectionIds: string[] | undefined,
  ): Promise<void> {
    if (desiredSectionIds === undefined) {
      return;
    }

    const currentJoins = await this.sectionPlaylistJoinRepository.find({
      where: { playlistId: playlist.id },
    });
    const currentSectionIds = currentJoins.map((join) => join.sectionId);

    const sectionIdsToRemove = currentSectionIds.filter(
      (sectionId) => !desiredSectionIds.includes(sectionId),
    );
    if (sectionIdsToRemove.length) {
      await this.sectionPlaylistJoinRepository.delete({
        playlistId: playlist.id,
        sectionId: In(sectionIdsToRemove),
      });
    }

    const sectionIdsToAdd = desiredSectionIds.filter(
      (sectionId) => !currentSectionIds.includes(sectionId),
    );
    await this.attachPlaylistToSections(playlist, sectionIdsToAdd);
  }

  private async artworkBlurhashesForPlaylists(
    playlists: readonly PlaylistEntity[],
  ): Promise<Map<string, string | null>> {
    return artworkBlurhashMap(
      this.picturesService,
      collectArtworkUrls(playlists),
    );
  }

  private async normalizePlaylists(
    playlists: PlaylistEntity[],
  ): Promise<NormalizedPlaylistResponse[]> {
    const blurhashes = await this.artworkBlurhashesForPlaylists(playlists);
    return playlists.map((playlist) =>
      this.normalizePlaylist(playlist, blurhashes),
    );
  }

  private normalizePlaylist(
    p: PlaylistEntity,
    blurhashes: Map<string, string | null>,
  ): NormalizedPlaylistResponse {
    const sermonJoins = p.sermonJoins ?? [];
    const sectionJoins = p.sectionJoins ?? [];
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      artwork: p.artwork,
      artworkBlurhash: blurhashes.get(p.artwork) ?? null,
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
        playlists: (sermonJoin.sermon.playlistJoins ?? []).map((pj) => ({
          id: pj.playlist.id,
          title: pj.playlist.title,
        })),
      })),
      createdAt: p.createdAt.toISOString(),
    };
  }
}
