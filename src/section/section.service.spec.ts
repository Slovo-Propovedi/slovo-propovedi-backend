import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { SectionService } from './section.service';
import { SectionEntity } from './entities/section.entity';
import { SectionPlaylistJoinEntity } from './entities/section-playlist-join.entity';
import { PlaylistService } from 'src/playlist/playlist.service';
import { PicturesService } from 'src/pictures/pictures.service';

describe('SectionService', () => {
  let service: SectionService;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    dataSource = { transaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SectionService,
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
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<SectionService>(SectionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('reorderSections', () => {
    it('rejects a non-uuid id before touching the database', async () => {
      await expect(
        service.reorderSections(['not-a-uuid']),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });
});
