import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import {
  PlaylistControllerCreateResponse,
  PlaylistControllerFindAllResponse,
} from 'src/generated';
import { PlaylistService } from './playlist.service';
import { PlaylistEntity } from './entities/playlist.entity';
import { PlaylistSermonJoinEntity } from './entities/playlist-sermon-join.entity';
import { SectionEntity } from 'src/section/entities/section.entity';
import { SectionPlaylistJoinEntity } from 'src/section/entities/section-playlist-join.entity';
import { SermonService } from 'src/sermon/sermon.service';
import { PicturesService } from 'src/pictures/pictures.service';

const ARTWORK_PLAYLIST = 'https://minio.example.com/files/artwork-p.jpg';
const ARTWORK_SERMON_1 = 'https://minio.example.com/files/artwork-1.jpg';
const ARTWORK_SERMON_2 = 'https://minio.example.com/files/artwork-2.jpg';

// Serializer-level guard: drive the REAL service normalizer and parse through
// the GENERATED response schema. The service unit tests bypass
// ZodSerializerInterceptor, so a missing createdAt on the playlist or on any
// nested sermon would otherwise become a production 500.

const PLAYLIST_CREATED = new Date('2026-10-20T09:00:00.000Z');
const SERMON_CREATED = new Date('2026-10-23T12:34:56.789Z');
const NESTED_SERMON_CREATED = new Date('2026-10-19T08:00:00.000Z');

const section = {
  id: 'section-1',
  title: 'Секция',
  description: 'Описание секции',
  position: 0,
  itemsSize: 'small',
  itemsRows: null,
  transform: 'middle',
  isDescriptionTitleOnSlideLarge: false,
  whereIsSlideTitleLocated: 'under',
  borderRadius: false,
} as SectionEntity;

const playlistBrief = {
  id: 'playlist-1',
  title: 'Плейлист',
} as PlaylistEntity;

const sermonEntity = {
  id: 'sermon-1',
  title: 'Проповедь',
  description: '',
  textFileUrl: null,
  audioUrl: null,
  youtubeUrl: null,
  artist: 'Автор',
  artwork: ARTWORK_SERMON_1,
  book: null,
  chapter: null,
  verse: null,
  createdAt: SERMON_CREATED,
  playlistJoins: [{ playlist: playlistBrief }],
} as SermonEntity;

const nestedSermonEntity = {
  ...sermonEntity,
  id: 'sermon-2',
  title: 'Вложенная проповедь',
  artwork: ARTWORK_SERMON_2,
  createdAt: NESTED_SERMON_CREATED,
} as SermonEntity;

const hydratedPlaylist = {
  id: 'playlist-1',
  title: 'Плейлист',
  description: 'Описание плейлиста',
  artwork: ARTWORK_PLAYLIST,
  createdAt: PLAYLIST_CREATED,
  sectionJoins: [
    {
      id: 'spj-1',
      playlistId: 'playlist-1',
      sectionId: section.id,
      position: 0,
      section,
    },
  ],
  sermonJoins: [
    {
      id: 'psj-1',
      playlistId: 'playlist-1',
      sermonId: sermonEntity.id,
      position: 0,
      sermon: sermonEntity,
    },
    {
      id: 'psj-2',
      playlistId: 'playlist-1',
      sermonId: nestedSermonEntity.id,
      position: 1,
      sermon: nestedSermonEntity,
    },
  ],
} as PlaylistEntity;

describe('PlaylistService serializer compatibility (generated schemas)', () => {
  let service: PlaylistService;
  let playlistRepository: {
    findAndCount: jest.Mock;
    findOne: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let picturesService: { findBlurhashes: jest.Mock };

  beforeEach(async () => {
    playlistRepository = {
      findAndCount: jest.fn(),
      findOne: jest.fn(),
    };
    dataSource = { transaction: jest.fn() };
    picturesService = { findBlurhashes: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlaylistService,
        { provide: SermonService, useValue: {} },
        { provide: PicturesService, useValue: picturesService },
        {
          provide: getRepositoryToken(PlaylistEntity),
          useValue: playlistRepository,
        },
        { provide: getRepositoryToken(SectionEntity), useValue: {} },
        {
          provide: getRepositoryToken(SectionPlaylistJoinEntity),
          useValue: {},
        },
        {
          provide: getRepositoryToken(PlaylistSermonJoinEntity),
          useValue: {},
        },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    service = module.get<PlaylistService>(PlaylistService);
  });

  it('GET /playlists response satisfies the generated strict schema, including nested createdAt', async () => {
    picturesService.findBlurhashes.mockResolvedValue(
      new Map([
        ['artwork-p.jpg', 'hash-p'],
        ['artwork-1.jpg', 'hash-1'],
        ['artwork-2.jpg', 'hash-2'],
      ]),
    );
    playlistRepository.findAndCount.mockResolvedValue([[hydratedPlaylist], 1]);

    const result = await service.findAll();
    const parsed = PlaylistControllerFindAllResponse.parse(result);

    expect(parsed.playlists[0].createdAt).toBe(PLAYLIST_CREATED.toISOString());
    expect(parsed.playlists[0].sections[0].title).toBe(section.title);
    expect(parsed.playlists[0].sermons).toHaveLength(2);
    expect(parsed.playlists[0].artworkBlurhash).toBe('hash-p');
    expect(parsed.playlists[0].sermons[0].artworkBlurhash).toBe('hash-1');
    expect(parsed.playlists[0].sermons[1].artworkBlurhash).toBe('hash-2');
  });

  it('POST /playlists response satisfies the generated strict schema, including nested createdAt', async () => {
    picturesService.findBlurhashes.mockResolvedValue(
      new Map([['artwork-p.jpg', 'hash-p']]),
    );
    const saved = { ...hydratedPlaylist };
    const manager = {
      getRepository: jest.fn().mockImplementation((entity) => {
        if (entity === PlaylistEntity) {
          return {
            create: jest.fn().mockReturnValue(saved),
            save: jest.fn().mockResolvedValue(saved),
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
    playlistRepository.findOne.mockResolvedValue(hydratedPlaylist);

    const result = await service.create({
      title: hydratedPlaylist.title,
      description: hydratedPlaylist.description,
      artwork: hydratedPlaylist.artwork,
    } as never);
    const parsed = PlaylistControllerCreateResponse.parse(result);

    expect(parsed.createdAt).toBe(PLAYLIST_CREATED.toISOString());
    expect(parsed.sections[0].title).toBe(section.title);
    expect(parsed.sermons).toHaveLength(2);
    expect(parsed.artworkBlurhash).toBe('hash-p');
    expect(parsed.sermons[0].artworkBlurhash).toBeNull();
    expect(parsed.sermons[1].artworkBlurhash).toBeNull();
  });
});
