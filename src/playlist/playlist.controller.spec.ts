import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { PlaylistController } from './playlist.controller';
import { PlaylistService } from './playlist.service';
import { PlaylistEntity } from './entities/playlist.entity';
import { PlaylistSermonJoinEntity } from './entities/playlist-sermon-join.entity';
import { SectionEntity } from 'src/section/entities/section.entity';
import { SectionPlaylistJoinEntity } from 'src/section/entities/section-playlist-join.entity';
import { SermonService } from 'src/sermon/sermon.service';
import { FindAllPlaylistsQueryDto } from './dto/find-all-playlists-query.dto';
import { UsersService } from 'src/users/users.service';
import { PicturesService } from 'src/pictures/pictures.service';

describe('PlaylistController', () => {
  let controller: PlaylistController;
  let service: PlaylistService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlaylistController],
      providers: [
        PlaylistService,
        {
          provide: JwtService,
          useValue: {},
        },
        {
          provide: UsersService,
          useValue: {},
        },
        {
          provide: SermonService,
          useValue: {},
        },
        {
          provide: PicturesService,
          useValue: { findBlurhashes: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: getRepositoryToken(PlaylistEntity),
          useValue: {},
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
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<PlaylistController>(PlaylistController);
    service = module.get<PlaylistService>(PlaylistService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates findAll, forwarding the optional search, pagination and sort queries to the service', async () => {
    const findAllSpy = jest
      .spyOn(service, 'findAll')
      .mockResolvedValue({ playlists: [], count: 0 });

    await controller.findAll({
      search: 'благодать',
      page: 2,
      limit: 20,
      sort: 'title',
      order: 'asc',
    } as FindAllPlaylistsQueryDto);
    await controller.findAll({} as FindAllPlaylistsQueryDto);

    expect(findAllSpy).toHaveBeenCalledWith('благодать', 2, 20, 'title', 'asc');
    expect(findAllSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});
