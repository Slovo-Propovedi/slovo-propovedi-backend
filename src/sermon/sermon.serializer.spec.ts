import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import {
  SermonControllerCreateResponse,
  SermonControllerFindAllResponse,
} from 'src/generated';
import { SermonService } from './sermon.service';
import { SermonEntity } from './entities/sermon.entity';
import { PlaylistEntity } from 'src/playlist/entities/playlist.entity';
import { PlaylistSermonJoinEntity } from 'src/playlist/entities/playlist-sermon-join.entity';
import { SectionEntity } from 'src/section/entities/section.entity';
import { SectionPlaylistJoinEntity } from 'src/section/entities/section-playlist-join.entity';
import { MinioService } from 'src/minio/minio.service';
import { PicturesService } from 'src/pictures/pictures.service';

const ARTWORK_1 = 'https://minio.example.com/files/artwork-1.jpg';
const ARTWORK_2 = 'https://minio.example.com/files/artwork-2.jpg';
const ARTWORK_PLAYLIST = 'https://minio.example.com/files/artwork-p.jpg';

// These tests drive the REAL service normalizers and then parse the result
// through the GENERATED response schemas. Unit tests on the service specs
// bypass ZodSerializerInterceptor, so a normalizer that forgets createdAt
// (on the top level OR any nested $ref shape) would only surface as a 500 in
// production. Parsing here makes that omission fail the suite.

const SERMON_CREATED = new Date('2026-10-23T12:34:56.789Z');
const PLAYLIST_CREATED = new Date('2026-10-20T09:00:00.000Z');
const NESTED_SERMON_CREATED = new Date('2026-10-19T08:00:00.000Z');

const section = {
  id: 'section-1',
  title: 'Секция',
  description: null,
  position: 0,
  itemsSize: 'small',
  itemsRows: null,
  transform: 'middle',
  isDescriptionTitleOnSlideLarge: false,
  whereIsSlideTitleLocated: 'under',
  borderRadius: false,
} as SectionEntity;

const nestedSermon = {
  id: 'sermon-2',
  title: 'Вложенная проповедь',
  description: '',
  textFileUrl: null,
  audioUrl: null,
  youtubeUrl: null,
  artist: 'Автор',
  artwork: ARTWORK_2,
  book: null,
  chapter: null,
  verse: null,
  createdAt: NESTED_SERMON_CREATED,
} as SermonEntity;

const pageSermon = {
  id: 'sermon-1',
  title: 'Проповедь',
  description: 'Описание',
  textFileUrl: null,
  audioUrl: 'https://minio.example.com/files/audio.mp3',
  youtubeUrl: null,
  artist: 'Автор',
  artwork: ARTWORK_1,
  book: null,
  chapter: null,
  verse: null,
  createdAt: SERMON_CREATED,
} as SermonEntity;

const playlist = {
  id: 'playlist-1',
  title: 'Плейлист',
  description: 'Описание плейлиста',
  artwork: ARTWORK_PLAYLIST,
  createdAt: PLAYLIST_CREATED,
} as PlaylistEntity;

// The fully hydrated graph the deep-relation findOne returns for POST
// /sermons and GET /sermons/:id: sermon → playlist → sections + sermons.
const hydratedSermon = {
  ...pageSermon,
  playlistJoins: [
    {
      id: 'psj-1',
      playlistId: playlist.id,
      sermonId: pageSermon.id,
      position: 0,
      playlist: {
        ...playlist,
        sectionJoins: [
          {
            id: 'spj-1',
            playlistId: playlist.id,
            sectionId: section.id,
            position: 0,
            section,
          },
        ],
        sermonJoins: [
          {
            id: 'psj-1',
            playlistId: playlist.id,
            sermonId: pageSermon.id,
            position: 0,
            sermon: pageSermon,
          },
          {
            id: 'psj-2',
            playlistId: playlist.id,
            sermonId: nestedSermon.id,
            position: 1,
            sermon: nestedSermon,
          },
        ],
      },
    },
  ],
} as SermonEntity;

// Generic chainable QueryBuilder mock (mirrors the service spec).
function mockBuilder(overrides: Record<string, unknown> = {}) {
  const queryBuilder = {
    leftJoin: jest.fn(),
    leftJoinAndSelect: jest.fn(),
    select: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    setParameter: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getMany: jest.fn(),
    getCount: jest.fn(),
    getRawMany: jest.fn(),
    getRawAndEntities: jest.fn(),
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
    'andWhere',
    'setParameter',
    'skip',
    'take',
  ].forEach((method) => queryBuilder[method].mockReturnValue(queryBuilder));
  queryBuilder.getMany.mockResolvedValue(overrides.getMany ?? []);
  queryBuilder.getCount.mockResolvedValue(overrides.getCount ?? 0);
  queryBuilder.getRawMany.mockResolvedValue([]);
  queryBuilder.getRawAndEntities.mockResolvedValue({ entities: [], raw: [] });
  return queryBuilder;
}

describe('SermonService serializer compatibility (generated schemas)', () => {
  let service: SermonService;
  let sermonRepository: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
  };
  let playlistRepository: { find: jest.Mock };
  let playlistSermonJoinRepository: { createQueryBuilder: jest.Mock };
  let sectionPlaylistJoinRepository: { createQueryBuilder: jest.Mock };
  let sectionRepository: { find: jest.Mock };
  let picturesService: { findBlurhashes: jest.Mock };

  beforeEach(async () => {
    sermonRepository = {
      createQueryBuilder: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    playlistRepository = { find: jest.fn() };
    playlistSermonJoinRepository = { createQueryBuilder: jest.fn() };
    sectionPlaylistJoinRepository = { createQueryBuilder: jest.fn() };
    sectionRepository = { find: jest.fn() };
    picturesService = { findBlurhashes: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SermonService,
        {
          provide: getRepositoryToken(SermonEntity),
          useValue: sermonRepository,
        },
        {
          provide: getRepositoryToken(PlaylistEntity),
          useValue: playlistRepository,
        },
        {
          provide: getRepositoryToken(PlaylistSermonJoinEntity),
          useValue: playlistSermonJoinRepository,
        },
        {
          provide: getRepositoryToken(SectionEntity),
          useValue: sectionRepository,
        },
        {
          provide: getRepositoryToken(SectionPlaylistJoinEntity),
          useValue: sectionPlaylistJoinRepository,
        },
        { provide: MinioService, useValue: { removeObjectByUrl: jest.fn() } },
        { provide: PicturesService, useValue: picturesService },
        { provide: getDataSourceToken(), useValue: {} },
      ],
    }).compile();

    service = module.get<SermonService>(SermonService);
  });

  it('GET /sermons response satisfies the generated strict schema, including nested createdAt', async () => {
    picturesService.findBlurhashes.mockResolvedValue(
      new Map([
        ['artwork-1.jpg', 'hash-1'],
        ['artwork-p.jpg', 'hash-p'],
      ]),
    );
    const pageBuilder = mockBuilder({ getMany: [pageSermon], getCount: 1 });
    sermonRepository.createQueryBuilder.mockReturnValue(pageBuilder);

    const pageSermonJoin = {
      id: 'psj-1',
      playlistId: playlist.id,
      sermonId: pageSermon.id,
      position: 0,
    };
    const playlistSermonJoins = [
      pageSermonJoin,
      {
        id: 'psj-2',
        playlistId: playlist.id,
        sermonId: nestedSermon.id,
        position: 1,
      },
    ];
    const joinBuilder = (rows: unknown[]) => {
      const builder = mockBuilder();
      builder.getMany.mockResolvedValue(rows);
      return builder;
    };
    playlistSermonJoinRepository.createQueryBuilder
      .mockReturnValueOnce(joinBuilder([pageSermonJoin]))
      .mockReturnValueOnce(joinBuilder(playlistSermonJoins))
      .mockReturnValueOnce(joinBuilder(playlistSermonJoins));
    playlistRepository.find
      .mockResolvedValueOnce([playlist])
      .mockResolvedValueOnce([playlist]);
    sectionPlaylistJoinRepository.createQueryBuilder.mockReturnValue(
      joinBuilder([
        {
          id: 'spj-1',
          playlistId: playlist.id,
          sectionId: section.id,
          position: 0,
        },
      ]),
    );
    sectionRepository.find.mockResolvedValue([section]);
    sermonRepository.find.mockResolvedValue([nestedSermon]);

    const result = await service.findAll();
    const parsed = SermonControllerFindAllResponse.parse(result);

    expect(parsed.sermons[0].createdAt).toBe(SERMON_CREATED.toISOString());
    expect(parsed.sermons[0].playlists[0].createdAt).toBe(
      PLAYLIST_CREATED.toISOString(),
    );
    expect(parsed.sermons[0].playlists[0].sections[0].title).toBe(
      section.title,
    );
    expect(parsed.sermons[0].artworkBlurhash).toBe('hash-1');
    expect(parsed.sermons[0].playlists[0].artworkBlurhash).toBe('hash-p');
    expect(parsed.sermons[0].playlists[0].sermons[0].artworkBlurhash).toBe(
      'hash-1',
    );
    expect(
      parsed.sermons[0].playlists[0].sermons[1].artworkBlurhash,
    ).toBeNull();
  });

  it('POST /sermons response satisfies the generated strict schema, including nested createdAt', async () => {
    picturesService.findBlurhashes.mockResolvedValue(
      new Map([
        ['artwork-1.jpg', 'hash-1'],
        ['artwork-2.jpg', 'hash-2'],
        ['artwork-p.jpg', 'hash-p'],
      ]),
    );
    sermonRepository.create.mockReturnValue({ id: pageSermon.id });
    sermonRepository.save.mockResolvedValue({ id: pageSermon.id });
    sermonRepository.findOne.mockResolvedValue(hydratedSermon);

    const result = await service.create({
      title: pageSermon.title,
      description: pageSermon.description,
      artwork: pageSermon.artwork,
      artist: pageSermon.artist,
    } as never);
    const parsed = SermonControllerCreateResponse.parse(result);

    expect(parsed.createdAt).toBe(SERMON_CREATED.toISOString());
    expect(parsed.playlists[0].createdAt).toBe(PLAYLIST_CREATED.toISOString());
    expect(parsed.playlists[0].sections[0].title).toBe(section.title);
    expect(parsed.playlists[0].sermons).toHaveLength(2);
    expect(parsed.artworkBlurhash).toBe('hash-1');
    expect(parsed.playlists[0].artworkBlurhash).toBe('hash-p');
    expect(parsed.playlists[0].sermons[0].artworkBlurhash).toBe('hash-1');
    expect(parsed.playlists[0].sermons[1].artworkBlurhash).toBe('hash-2');
  });
});
