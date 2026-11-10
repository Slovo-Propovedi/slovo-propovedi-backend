import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { SectionController } from './section.controller';
import { SectionService } from './section.service';
import { SectionEntity } from './entities/section.entity';
import { SectionPlaylistJoinEntity } from './entities/section-playlist-join.entity';
import { PlaylistService } from 'src/playlist/playlist.service';
import { UsersService } from 'src/users/users.service';
import { PicturesService } from 'src/pictures/pictures.service';

describe('SectionController', () => {
  let controller: SectionController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SectionController],
      providers: [
        SectionService,
        {
          provide: JwtService,
          useValue: {},
        },
        {
          provide: UsersService,
          useValue: {},
        },
        {
          provide: PlaylistService,
          useValue: {},
        },
        {
          provide: PicturesService,
          useValue: { findBlurhashes: jest.fn().mockResolvedValue(new Map()) },
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
          provide: getDataSourceToken(),
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<SectionController>(SectionController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
