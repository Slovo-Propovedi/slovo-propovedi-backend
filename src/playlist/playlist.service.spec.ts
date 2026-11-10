import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import {
  PlaylistService,
  buildPlaylistSearchVectorExpression,
} from './playlist.service';
import { PlaylistEntity } from './entities/playlist.entity';
import { PlaylistSermonJoinEntity } from './entities/playlist-sermon-join.entity';
import { SectionEntity } from 'src/section/entities/section.entity';
import { SectionPlaylistJoinEntity } from 'src/section/entities/section-playlist-join.entity';
import { SermonService } from 'src/sermon/sermon.service';
import { PicturesService } from 'src/pictures/pictures.service';

// Mirror of the service's canonical tsvector expression — asserting the exact
// string guards the runtime behavior against accidental edits to
// PLAYLIST_SEARCH_WEIGHTS (and keeps the migration
// sql/migrations/006_playlist_search_tsvector.sql honest).
const PLAYLIST_SEARCH_VECTOR_EXPRESSION =
  "setweight(to_tsvector('russian', coalesce(title, '')), 'A') || " +
  "setweight(to_tsvector('russian', coalesce(description, '')), 'D')";

const PLAYLIST_RANK_EXPRESSION =
  "ts_rank('{0.1,0.2,0.4,1.0}'::float4[], playlist.search_vector, to_tsquery('russian', :tsquery))";

const PLAYLIST_SEARCH_CONDITION =
  "playlist.search_vector @@ to_tsquery('russian', :tsquery)";

// Mirrors of the service's relation graph constants — asserting the exact
// findAndCount arguments guards the no-search path against regressions.
const PLAYLIST_RELATIONS = {
  sermonJoins: {
    sermon: {
      playlistJoins: { playlist: true },
    },
  },
  sectionJoins: { section: true },
};

const PLAYLIST_ORDER = {
  createdAt: 'DESC',
  id: 'DESC',
  sermonJoins: { position: 'ASC' },
  sectionJoins: { position: 'ASC' },
};

const PLAYLIST_DATE_ORDER_EXPRESSION = `date_trunc('milliseconds', playlist.created_at)`;

describe('PlaylistService', () => {
  let service: PlaylistService;
  let playlistRepository: {
    createQueryBuilder: jest.Mock;
    findAndCount: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let picturesService: { findBlurhashes: jest.Mock };

  beforeEach(async () => {
    playlistRepository = {
      createQueryBuilder: jest.fn(),
      findAndCount: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
    };
    dataSource = { transaction: jest.fn() };
    picturesService = {
      findBlurhashes: jest.fn().mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlaylistService,
        {
          provide: SermonService,
          useValue: {},
        },
        {
          provide: PicturesService,
          useValue: picturesService,
        },
        {
          provide: getRepositoryToken(PlaylistEntity),
          useValue: playlistRepository,
        },
        {
          provide: getRepositoryToken(SectionEntity),
          useValue: {},
        },
        {
          provide: getRepositoryToken(SectionPlaylistJoinEntity),
          useValue: {},
        },
        {
          provide: getRepositoryToken(PlaylistSermonJoinEntity),
          useValue: {},
        },
        {
          provide: getDataSourceToken(),
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<PlaylistService>(PlaylistService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('buildPlaylistSearchVectorExpression (single source of truth for weights)', () => {
    it('weights title A and description D in the migration order', () => {
      expect(buildPlaylistSearchVectorExpression()).toBe(
        PLAYLIST_SEARCH_VECTOR_EXPRESSION,
      );
    });
  });

  describe('findAll', () => {
    function mockQueryBuilder() {
      const queryBuilder = {
        leftJoin: jest.fn(),
        leftJoinAndSelect: jest.fn(),
        select: jest.fn(),
        groupBy: jest.fn(),
        orderBy: jest.fn(),
        addOrderBy: jest.fn(),
        addSelect: jest.fn(),
        where: jest.fn(),
        setParameter: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        getManyAndCount: jest.fn(),
        getRawMany: jest.fn(),
        getCount: jest.fn(),
      };
      [
        'leftJoin',
        'leftJoinAndSelect',
        'select',
        'groupBy',
        'orderBy',
        'addOrderBy',
        'addSelect',
        'where',
        'setParameter',
        'skip',
        'take',
      ].forEach((method) => queryBuilder[method].mockReturnValue(queryBuilder));
      queryBuilder.getManyAndCount.mockResolvedValue([[], 0]);
      queryBuilder.getRawMany.mockResolvedValue([]);
      queryBuilder.getCount.mockResolvedValue(0);
      playlistRepository.createQueryBuilder.mockReturnValue(queryBuilder);
      return queryBuilder;
    }

    it('keeps the findAndCount path with DB-level relation ordering when search is absent', async () => {
      playlistRepository.findAndCount.mockResolvedValue([[], 5]);

      const result = await service.findAll();

      expect(playlistRepository.findAndCount).toHaveBeenCalledWith({
        relations: PLAYLIST_RELATIONS,
        order: PLAYLIST_ORDER,
      });
      expect(playlistRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ playlists: [], count: 5 });
    });

    it('ranks by relevance (rank DESC, id DESC) and filters by FTS when search is present', async () => {
      const queryBuilder = mockQueryBuilder();
      queryBuilder.getManyAndCount.mockResolvedValue([[], 2]);

      const result = await service.findAll('благодать');

      // The deep relation graph must match the findAndCount path exactly:
      // normalizePlaylist treats absent relations as [], so a dropped join
      // would be silent data loss invisible to the suite.
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'playlist.sermonJoins',
        'sermonJoins',
      );
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'sermonJoins.sermon',
        'sermons',
      );
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'sermons.playlistJoins',
        'sermonPlaylistJoins',
      );
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'sermonPlaylistJoins.playlist',
        'sermonPlaylists',
      );
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'playlist.sectionJoins',
        'sectionJoins',
      );
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
        'sectionJoins.section',
        'sections',
      );
      expect(queryBuilder.addSelect).toHaveBeenCalledWith(
        PLAYLIST_RANK_EXPRESSION,
        'rank',
      );
      expect(queryBuilder.where).toHaveBeenCalledWith(
        PLAYLIST_SEARCH_CONDITION,
      );
      expect(queryBuilder.setParameter).toHaveBeenCalledWith(
        'tsquery',
        'благодать:*',
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('rank', 'DESC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
        'playlist.id',
        'DESC',
      );
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
        'sermonJoins.position',
        'ASC',
      );
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
        'sectionJoins.position',
        'ASC',
      );
      expect(queryBuilder.getManyAndCount).toHaveBeenCalledTimes(1);
      expect(playlistRepository.findAndCount).not.toHaveBeenCalled();
      expect(result).toEqual({ playlists: [], count: 2 });
    });

    it('passes the sanitized tsquery to the parameter binding', async () => {
      const queryBuilder = mockQueryBuilder();

      await service.findAll('Благодать');

      expect(queryBuilder.setParameter).toHaveBeenCalledWith(
        'tsquery',
        'Благодать:*',
      );
    });

    describe('sort/order (full-fetch path)', () => {
      it('routes sort=title through the QueryBuilder (not findAndCount) with LOWER(title) ASC orders', async () => {
        const queryBuilder = mockQueryBuilder();
        queryBuilder.getManyAndCount.mockResolvedValue([[], 4]);

        const result = await service.findAll(
          undefined,
          undefined,
          undefined,
          'title',
          'asc',
        );

        expect(playlistRepository.findAndCount).not.toHaveBeenCalled();
        expect(queryBuilder.getManyAndCount).toHaveBeenCalledTimes(1);
        expect(queryBuilder.orderBy).toHaveBeenCalledWith(
          'LOWER(playlist.title)',
          'ASC',
        );
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
          'sermonJoins.position',
          'ASC',
        );
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
          'sectionJoins.position',
          'ASC',
        );
        expect(result).toEqual({ playlists: [], count: 4 });
      });

      it('orders by LOWER(section title) ASC NULLS LAST, join position, then id DESC for sort=section', async () => {
        const queryBuilder = mockQueryBuilder();

        await service.findAll(
          undefined,
          undefined,
          undefined,
          'section',
          'asc',
        );

        expect(playlistRepository.findAndCount).not.toHaveBeenCalled();
        expect(queryBuilder.orderBy).toHaveBeenCalledWith(
          'LOWER(sections.title)',
          'ASC',
          'NULLS LAST',
        );
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
          'sectionJoins.position',
          'ASC',
        );
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith(
          'sectionJoins.section',
          'sections',
        );
      });

      it('routes an explicit asc direction on the default date sort through the QueryBuilder', async () => {
        const queryBuilder = mockQueryBuilder();

        await service.findAll(undefined, undefined, undefined, 'date', 'asc');

        expect(playlistRepository.findAndCount).not.toHaveBeenCalled();
        expect(queryBuilder.orderBy).toHaveBeenCalledWith(
          PLAYLIST_DATE_ORDER_EXPRESSION,
          'ASC',
        );
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        expect(queryBuilder.getManyAndCount).toHaveBeenCalledTimes(1);
      });

      it('ignores sort/order under search: rank DESC then id DESC win', async () => {
        const queryBuilder = mockQueryBuilder();
        queryBuilder.getManyAndCount.mockResolvedValue([[], 2]);

        await service.findAll(
          'благодать',
          undefined,
          undefined,
          'title',
          'asc',
        );

        expect(queryBuilder.orderBy).toHaveBeenCalledWith('rank', 'DESC');
        expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        expect(queryBuilder.orderBy).not.toHaveBeenCalledWith(
          'LOWER(playlist.title)',
          expect.anything(),
        );
        expect(queryBuilder.where).toHaveBeenCalledWith(
          PLAYLIST_SEARCH_CONDITION,
        );
      });
    });

    it('fails fast on punctuation-only search without touching the repository', async () => {
      await expect(service.findAll('!!!')).rejects.toThrow(BadRequestException);

      expect(playlistRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(playlistRepository.findAndCount).not.toHaveBeenCalled();
    });

    it('never touches the QueryBuilder for undefined or empty search', async () => {
      playlistRepository.findAndCount.mockResolvedValue([[], 0]);

      await service.findAll();
      await service.findAll(undefined);
      await service.findAll('');

      expect(playlistRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    describe('offset path (page/limit supplied)', () => {
      const playlistEntity = (id: string): PlaylistEntity => ({
        id,
        title: `Плейлист ${id}`,
        description: '',
        artwork: '',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        sectionJoins: [],
        sermonJoins: [],
      });

      it('pages parent ids by created_at DESC then id DESC, counts separately and hydrates via IN', async () => {
        const idBuilder = mockQueryBuilder();
        idBuilder.getRawMany.mockResolvedValue([
          { id: 'pl-3' },
          { id: 'pl-2' },
        ]);
        const countBuilder = mockQueryBuilder();
        countBuilder.getCount.mockResolvedValue(5);
        playlistRepository.createQueryBuilder
          .mockReturnValueOnce(idBuilder)
          .mockReturnValueOnce(countBuilder);
        playlistRepository.find.mockResolvedValue([
          playlistEntity('pl-2'),
          playlistEntity('pl-3'),
        ]);

        const result = await service.findAll(undefined, 1, 2);

        expect(idBuilder.select).toHaveBeenCalledWith('playlist.id', 'id');
        expect(idBuilder.orderBy).toHaveBeenCalledWith(
          PLAYLIST_DATE_ORDER_EXPRESSION,
          'DESC',
        );
        expect(idBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        expect(idBuilder.skip).toHaveBeenCalledWith(0);
        expect(idBuilder.take).toHaveBeenCalledWith(2);
        expect(idBuilder.getRawMany).toHaveBeenCalledTimes(1);
        expect(countBuilder.getCount).toHaveBeenCalledTimes(1);
        expect(playlistRepository.find).toHaveBeenCalledWith({
          where: { id: In(['pl-3', 'pl-2']) },
          relations: PLAYLIST_RELATIONS,
          order: PLAYLIST_ORDER,
        });
        // The hydrated rows came back shuffled — the response must follow the
        // id-page order (pl-3 before pl-2).
        expect(result.playlists.map((p) => p.id)).toEqual(['pl-3', 'pl-2']);
        expect(result.count).toBe(5);
      });

      it('orders the id page by rank DESC then id DESC under search', async () => {
        const idBuilder = mockQueryBuilder();
        idBuilder.getRawMany.mockResolvedValue([{ id: 'pl-1' }]);
        const countBuilder = mockQueryBuilder();
        countBuilder.getCount.mockResolvedValue(1);
        playlistRepository.createQueryBuilder
          .mockReturnValueOnce(idBuilder)
          .mockReturnValueOnce(countBuilder);
        playlistRepository.find.mockResolvedValue([playlistEntity('pl-1')]);

        await service.findAll('благодать', 1, 10);

        expect(idBuilder.addSelect).toHaveBeenCalledWith(
          PLAYLIST_RANK_EXPRESSION,
          'rank',
        );
        expect(idBuilder.where).toHaveBeenCalledWith(PLAYLIST_SEARCH_CONDITION);
        expect(idBuilder.setParameter).toHaveBeenCalledWith(
          'tsquery',
          'благодать:*',
        );
        expect(idBuilder.orderBy).toHaveBeenCalledWith('rank', 'DESC');
        expect(idBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        // The count query applies the same FTS filter on its own builder.
        expect(countBuilder.where).toHaveBeenCalledWith(
          PLAYLIST_SEARCH_CONDITION,
        );
      });

      it('uses page 1 when only limit is supplied', async () => {
        const idBuilder = mockQueryBuilder();
        idBuilder.getRawMany.mockResolvedValue([]);
        const countBuilder = mockQueryBuilder();
        countBuilder.getCount.mockResolvedValue(0);
        playlistRepository.createQueryBuilder
          .mockReturnValueOnce(idBuilder)
          .mockReturnValueOnce(countBuilder);
        playlistRepository.find.mockResolvedValue([]);

        const result = await service.findAll(undefined, undefined, 20);

        expect(idBuilder.skip).toHaveBeenCalledWith(0);
        expect(idBuilder.take).toHaveBeenCalledWith(20);
        expect(result).toEqual({ playlists: [], count: 0 });
      });

      it('fails fast when a page id is missing from the hydration query (dangling FK)', async () => {
        const idBuilder = mockQueryBuilder();
        idBuilder.getRawMany.mockResolvedValue([
          { id: 'pl-1' },
          { id: 'pl-missing' },
        ]);
        const countBuilder = mockQueryBuilder();
        countBuilder.getCount.mockResolvedValue(2);
        playlistRepository.createQueryBuilder
          .mockReturnValueOnce(idBuilder)
          .mockReturnValueOnce(countBuilder);
        playlistRepository.find.mockResolvedValue([playlistEntity('pl-1')]);
        const loggerSpy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);

        const error = await service
          .findAll(undefined, 1, 10)
          .catch((caught) => caught);

        expect(error).toBeInstanceOf(InternalServerErrorException);
        expect(error.message).toBe('Internal server error');
        expect(loggerSpy.mock.calls[0][0]).toContain(
          'Playlist "pl-missing" missing from hydration query',
        );
        loggerSpy.mockRestore();
      });

      it('orders the id page by LOWER(title) ASC then id DESC for offset sort=title', async () => {
        const idBuilder = mockQueryBuilder();
        idBuilder.getRawMany.mockResolvedValue([{ id: 'pl-2' }]);
        const countBuilder = mockQueryBuilder();
        countBuilder.getCount.mockResolvedValue(5);
        playlistRepository.createQueryBuilder
          .mockReturnValueOnce(idBuilder)
          .mockReturnValueOnce(countBuilder);
        playlistRepository.find.mockResolvedValue([playlistEntity('pl-2')]);

        const result = await service.findAll(undefined, 1, 10, 'title', 'asc');

        expect(idBuilder.leftJoin).not.toHaveBeenCalled();
        expect(idBuilder.groupBy).not.toHaveBeenCalled();
        expect(idBuilder.orderBy).toHaveBeenCalledWith(
          'LOWER(playlist.title)',
          'ASC',
        );
        expect(idBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        expect(idBuilder.skip).toHaveBeenCalledWith(0);
        expect(idBuilder.take).toHaveBeenCalledWith(10);
        expect(idBuilder.getRawMany).toHaveBeenCalledTimes(1);
        expect(result.playlists.map((p) => p.id)).toEqual(['pl-2']);
        expect(result.count).toBe(5);
      });

      it('pages parent ids via GROUP BY for offset sort=section (one row per playlist)', async () => {
        const idBuilder = mockQueryBuilder();
        idBuilder.getRawMany.mockResolvedValue([
          { id: 'pl-3' },
          { id: 'pl-1' },
        ]);
        const countBuilder = mockQueryBuilder();
        countBuilder.getCount.mockResolvedValue(5);
        playlistRepository.createQueryBuilder
          .mockReturnValueOnce(idBuilder)
          .mockReturnValueOnce(countBuilder);
        playlistRepository.find.mockResolvedValue([
          playlistEntity('pl-1'),
          playlistEntity('pl-3'),
        ]);

        const result = await service.findAll(undefined, 1, 2, 'section', 'asc');

        expect(idBuilder.leftJoin).toHaveBeenCalledWith(
          'playlist.sectionJoins',
          'sectionJoins',
        );
        expect(idBuilder.leftJoin).toHaveBeenCalledWith(
          'sectionJoins.section',
          'sections',
        );
        expect(idBuilder.groupBy).toHaveBeenCalledWith('playlist.id');
        expect(idBuilder.orderBy).toHaveBeenCalledWith(
          'MIN(LOWER(sections.title))',
          'ASC',
          'NULLS LAST',
        );
        expect(idBuilder.addOrderBy).toHaveBeenCalledWith(
          'MIN(sectionJoins.position)',
          'ASC',
        );
        expect(idBuilder.addOrderBy).toHaveBeenCalledWith(
          'playlist.id',
          'DESC',
        );
        expect(idBuilder.skip).toHaveBeenCalledWith(0);
        expect(idBuilder.take).toHaveBeenCalledWith(2);
        expect(playlistRepository.find).toHaveBeenCalledWith({
          where: { id: In(['pl-3', 'pl-1']) },
          relations: PLAYLIST_RELATIONS,
          order: PLAYLIST_ORDER,
        });
        // Hydration returned the rows shuffled — the response must follow the
        // id-page order.
        expect(result.playlists.map((p) => p.id)).toEqual(['pl-3', 'pl-1']);
        expect(result.count).toBe(5);
      });
    });
  });

  describe('create (null description coercion)', () => {
    it('coerces a null description to an empty string before persisting', async () => {
      const createMock = jest
        .fn()
        .mockImplementation((dto) => ({ id: 'pl-1', ...dto }));
      const saveMock = jest.fn().mockResolvedValue({
        id: 'pl-1',
        title: 'Тест',
        description: '',
        artwork: '',
      });
      const manager = {
        getRepository: jest.fn().mockImplementation((entity) => {
          if (entity === PlaylistEntity) {
            return { create: createMock, save: saveMock };
          }
          if (entity === PlaylistSermonJoinEntity) {
            return { create: jest.fn(), save: jest.fn() };
          }
          throw new Error(`unexpected entity ${entity}`);
        }),
      };
      dataSource.transaction = jest
        .fn()
        .mockImplementation(async (_isolation, callback) => callback(manager));
      playlistRepository.findOne = jest.fn().mockResolvedValue({
        id: 'pl-1',
        title: 'Тест',
        description: '',
        artwork: '',
        sermonJoins: [],
        sectionJoins: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await service.create({
        title: 'Тест',
        description: null,
        artwork: '',
      } as never);

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Тест',
          description: '',
          artwork: '',
        }),
      );
      expect(saveMock).toHaveBeenCalledTimes(1);
    });

    it('keeps a non-null description as-is', async () => {
      const createMock = jest
        .fn()
        .mockImplementation((dto) => ({ id: 'pl-1', ...dto }));
      const manager = {
        getRepository: jest.fn().mockImplementation((entity) => {
          if (entity === PlaylistEntity) {
            return {
              create: createMock,
              save: jest.fn().mockResolvedValue({ id: 'pl-1' }),
            };
          }
          if (entity === PlaylistSermonJoinEntity) {
            return { create: jest.fn(), save: jest.fn() };
          }
          throw new Error(`unexpected entity ${entity}`);
        }),
      };
      dataSource.transaction = jest
        .fn()
        .mockImplementation(async (_isolation, callback) => callback(manager));
      playlistRepository.findOne = jest.fn().mockResolvedValue({
        id: 'pl-1',
        title: 'Тест',
        description: 'Описание',
        artwork: '',
        sermonJoins: [],
        sectionJoins: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await service.create({
        title: 'Тест',
        description: 'Описание',
        artwork: '',
      } as never);

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Описание' }),
      );
    });
  });

  describe('update (null description coercion)', () => {
    it('coerces a null description to an empty string on update', async () => {
      playlistRepository.findOne = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'pl-1',
          title: 'Тест',
          description: 'Старое',
          artwork: '',
          sermonJoins: [],
          sectionJoins: [],
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 'pl-1',
          title: 'Тест',
          description: '',
          artwork: '',
          sermonJoins: [],
          sectionJoins: [],
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });
      playlistRepository.save = jest
        .fn()
        .mockImplementation(async (playlist) => playlist);

      await service.update('pl-1', { description: null } as never);

      expect(playlistRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ description: '' }),
      );
    });

    it('keeps a non-null description as-is on update', async () => {
      playlistRepository.findOne = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'pl-1',
          title: 'Тест',
          description: 'Старое',
          artwork: '',
          sermonJoins: [],
          sectionJoins: [],
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 'pl-1',
          title: 'Тест',
          description: 'Новое',
          artwork: '',
          sermonJoins: [],
          sectionJoins: [],
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });
      playlistRepository.save = jest
        .fn()
        .mockImplementation(async (playlist) => playlist);

      await service.update('pl-1', { description: 'Новое' } as never);

      expect(playlistRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Новое' }),
      );
    });
  });
});
