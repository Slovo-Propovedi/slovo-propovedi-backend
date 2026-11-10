import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { SectionEntity } from './entities/section.entity';
import { SectionPlaylistJoinEntity } from './entities/section-playlist-join.entity';
import { DataSource, In, Repository } from 'typeorm';
import {
  AllSectionsResponse,
  NormalizedPlaylist,
  NormalizedSection,
} from './interfacies/interface';
import { PlaylistService } from 'src/playlist/playlist.service';
import { artworkBlurhashMap } from 'src/pictures/artwork-blurhash';
import { PicturesService } from 'src/pictures/pictures.service';
import { toInternalServerError } from 'src/shared/internal-error';
import { ReorderSectionsBody } from 'src/generated';

// TypeORM 1.0 dropped the string-array form of `relations`; the object form
// below encodes the same nested relation graph.
const SECTION_RELATIONS = {
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

// DB-level ordering for every relation path the normalize functions expose.
// Sections by global position, then their playlist joins, then each nested
// playlist's own section/sermon joins — so no in-memory re-sorting is needed.
const SECTION_ORDER = {
  position: 'ASC',
  playlistJoins: {
    position: 'ASC',
    playlist: {
      sectionJoins: { position: 'ASC' },
      sermonJoins: { position: 'ASC' },
    },
  },
} as const;

/**
 * Every artwork URL a normalized section response can contain: each attached
 * playlist and each sermon nested inside those playlists. Gathered once per
 * response so the blurhash lookup is a single batched query.
 */
const collectArtworkUrls = (sections: readonly SectionEntity[]): string[] => {
  const urls: string[] = [];
  for (const section of sections) {
    for (const playlistJoin of section.playlistJoins ?? []) {
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

@Injectable()
export class SectionService {
  private readonly logger = new Logger(SectionService.name);

  constructor(
    private playlistService: PlaylistService,
    private readonly picturesService: PicturesService,
    @InjectRepository(SectionEntity)
    private sectionRepository: Repository<SectionEntity>,
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  async createSectionItem(
    createSectionDto: CreateSectionDto,
  ): Promise<NormalizedSection> {
    try {
      return await this.dataSource.transaction(
        'SERIALIZABLE',
        async (manager) => {
          const sectionRepository = manager.getRepository(SectionEntity);
          // SERIALIZABLE isolation prevents two concurrent creates from both
          // reading the same max position and inserting duplicate positions.
          const maxPosition = await sectionRepository.maximum('position');
          const section = sectionRepository.create({
            title: createSectionDto.title,
            description: createSectionDto.description,
            itemsSize: createSectionDto.itemsSize,
            itemsRows: createSectionDto.itemsRows,
            transform: createSectionDto.transform,
            isDescriptionTitleOnSlideLarge:
              createSectionDto.isDescriptionTitleOnSlideLarge,
            whereIsSlideTitleLocated: createSectionDto.whereIsSlideTitleLocated,
            borderRadius: createSectionDto.borderRadius,
            position: (maxPosition ?? -1) + 1,
            playlistJoins: [],
          });
          const saved = await sectionRepository.save(section);
          return this.normalizeSection(saved, new Map());
        },
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'createSectionItem', error);
    }
  }

  async findByIds(ids: string[]): Promise<SectionEntity[]> {
    try {
      if (!ids.length) {
        throw new BadRequestException('ids in empty');
      }
      return await this.sectionRepository.find({ where: { id: In(ids) } });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findByIds section', error);
    }
  }

  async findAllSectionItems(): Promise<AllSectionsResponse> {
    try {
      const [result, count] = await this.sectionRepository.findAndCount({
        relations: SECTION_RELATIONS,
        order: SECTION_ORDER,
      });
      return {
        sections: await this.normalizeSections(result),
        count: count,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findAllSectionItems', error);
    }
  }

  async findOneSectionItem(id: string): Promise<NormalizedSection | null> {
    try {
      const section = await this.sectionRepository.findOne({
        where: { id },
        relations: SECTION_RELATIONS,
        order: SECTION_ORDER,
      });
      if (!section) {
        return null;
      }
      const blurhashes = await this.artworkBlurhashesForSections([section]);
      return this.normalizeSection(section, blurhashes);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'findOneSectionItem', error);
    }
  }

  async update(
    id: string,
    updateSectionDto: UpdateSectionDto,
  ): Promise<NormalizedSection> {
    try {
      const section = await this.sectionRepository.findOne({
        where: { id },
        relations: SECTION_RELATIONS,
        order: SECTION_ORDER,
      });

      if (!section) {
        throw new NotFoundException('Section not found');
      }

      if (updateSectionDto.title !== undefined) {
        section.title = updateSectionDto.title;
      }
      if (updateSectionDto.description !== undefined) {
        section.description = updateSectionDto.description;
      }
      if (updateSectionDto.itemsSize !== undefined) {
        section.itemsSize = updateSectionDto.itemsSize;
      }
      if (updateSectionDto.itemsRows !== undefined) {
        section.itemsRows = updateSectionDto.itemsRows;
      }
      if (updateSectionDto.transform !== undefined) {
        section.transform = updateSectionDto.transform;
      }
      if (updateSectionDto.isDescriptionTitleOnSlideLarge !== undefined) {
        section.isDescriptionTitleOnSlideLarge =
          updateSectionDto.isDescriptionTitleOnSlideLarge;
      }
      if (updateSectionDto.whereIsSlideTitleLocated !== undefined) {
        section.whereIsSlideTitleLocated =
          updateSectionDto.whereIsSlideTitleLocated;
      }
      if (updateSectionDto.borderRadius !== undefined) {
        section.borderRadius = updateSectionDto.borderRadius;
      }

      await this.sectionRepository.save(section);

      if (updateSectionDto.playlistsIds !== undefined) {
        await this.replaceSectionPlaylists(id, updateSectionDto.playlistsIds);
      }

      const reloaded = await this.sectionRepository.findOne({
        where: { id },
        relations: SECTION_RELATIONS,
        order: SECTION_ORDER,
      });
      if (!reloaded) {
        throw new NotFoundException('Section not found after update');
      }
      const blurhashes = await this.artworkBlurhashesForSections([reloaded]);
      return this.normalizeSection(reloaded, blurhashes);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'update', error);
    }
  }

  async remove(id: string) {
    try {
      await this.sectionRepository.delete(id);
      return { status: 'success' };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw toInternalServerError(this.logger, 'remove', error);
    }
  }

  async reorderSections(ids: string[]): Promise<{ status: string }> {
    // Local invariant: ids are interpolated into the CASE expression below, so
    // they are parsed here even though the HTTP DTO already enforces uuid().
    // The service must never trust its caller.
    const parsed = ReorderSectionsBody.safeParse({ ids });
    if (!parsed.success) {
      throw new BadRequestException('Section IDs must be valid UUIDs');
    }
    const validatedIds = parsed.data.ids;

    if (!validatedIds.length) {
      throw new BadRequestException('IDs array cannot be empty');
    }
    if (new Set(validatedIds).size !== validatedIds.length) {
      throw new BadRequestException('Duplicate IDs detected');
    }

    return this.dataSource.transaction(async (manager) => {
      const sectionRepository = manager.getRepository(SectionEntity);

      // The client must send the complete in-scope set; a partial list would
      // silently collide positions for the omitted sections.
      const total = await sectionRepository.count();
      if (validatedIds.length !== total) {
        throw new BadRequestException(
          `Reorder list must contain all ${total} items in scope, received ${validatedIds.length}`,
        );
      }

      const existing = await sectionRepository.find({
        where: { id: In(validatedIds) },
        select: { id: true },
      });
      if (existing.length !== validatedIds.length) {
        throw new NotFoundException('Some sections do not exist');
      }

      // A single CASE UPDATE replaces the previous per-id loop (N queries).
      // IDs are UUIDs (parsed above), so interpolating them into the CASE
      // expression is injection-safe.
      const positionCase = validatedIds
        .map((id, index) => `WHEN '${id}' THEN ${index}`)
        .join(' ');
      await sectionRepository
        .createQueryBuilder()
        .update(SectionEntity)
        .set({ position: () => `CASE id ${positionCase} END` })
        .where('id IN (:...ids)', { ids: validatedIds })
        .execute();

      return { status: 'success' };
    });
  }

  async reorderPlaylistsInSection(
    sectionId: string,
    playlistIds: string[],
  ): Promise<{ status: string }> {
    if (!playlistIds.length) {
      throw new BadRequestException('Playlist IDs array cannot be empty');
    }
    if (new Set(playlistIds).size !== playlistIds.length) {
      throw new BadRequestException('Duplicate playlist IDs detected');
    }

    return this.dataSource.transaction(async (manager) => {
      const sectionRepository = manager.getRepository(SectionEntity);
      const section = await sectionRepository.findOne({
        where: { id: sectionId },
        select: { id: true },
      });
      if (!section) {
        throw new NotFoundException(`Section with id "${sectionId}" not found`);
      }

      const joinRepository = manager.getRepository(SectionPlaylistJoinEntity);

      // The client must send the complete in-scope set; a partial list would
      // silently collide positions for the omitted playlists.
      const total = await joinRepository.count({ where: { sectionId } });
      if (playlistIds.length !== total) {
        throw new BadRequestException(
          `Reorder list must contain all ${total} items in scope, received ${playlistIds.length}`,
        );
      }

      const joins = await joinRepository.find({
        where: { sectionId, playlistId: In(playlistIds) },
      });
      if (joins.length !== playlistIds.length) {
        throw new NotFoundException('Some playlists are not in the section');
      }

      const joinByPlaylistId = new Map(
        joins.map((join) => [join.playlistId, join]),
      );
      // A single CASE UPDATE replaces the previous per-id loop (N queries).
      // Join ids are UUIDs generated by the DB, so interpolation is safe.
      const positionCase = playlistIds
        .map((playlistId, index) => {
          const join = joinByPlaylistId.get(playlistId);
          if (!join) {
            throw new NotFoundException(
              `Playlist with id "${playlistId}" is not in the section`,
            );
          }
          return `WHEN '${join.id}' THEN ${index}`;
        })
        .join(' ');
      await joinRepository
        .createQueryBuilder()
        .update(SectionPlaylistJoinEntity)
        .set({ position: () => `CASE id ${positionCase} END` })
        .where('id IN (:...ids)', { ids: joins.map((join) => join.id) })
        .execute();

      return { status: 'success' };
    });
  }

  private async replaceSectionPlaylists(
    sectionId: string,
    playlistIds: string[],
  ): Promise<void> {
    if (playlistIds.length > 0) {
      const playlists = await this.playlistService.findByIds(playlistIds);
      if (playlists.length !== playlistIds.length) {
        throw new NotFoundException('Some playlists not found');
      }
    }

    // Delete + insert run in one transaction so a failed insert cannot leave
    // the section with zero playlists.
    await this.dataSource.transaction(async (manager) => {
      const joinRepository = manager.getRepository(SectionPlaylistJoinEntity);
      await joinRepository.delete({ sectionId });

      if (playlistIds.length === 0) {
        return;
      }

      const joinRows = playlistIds.map((playlistId, index) =>
        joinRepository.create({
          sectionId,
          playlistId,
          position: index,
        }),
      );
      await joinRepository.save(joinRows);
    });
  }

  private async artworkBlurhashesForSections(
    sections: readonly SectionEntity[],
  ): Promise<Map<string, string | null>> {
    return artworkBlurhashMap(
      this.picturesService,
      collectArtworkUrls(sections),
    );
  }

  private async normalizeSections(
    sections: SectionEntity[],
  ): Promise<NormalizedSection[]> {
    const blurhashes = await this.artworkBlurhashesForSections(sections);
    return sections.map((section) =>
      this.normalizeSection(section, blurhashes),
    );
  }

  private normalizeSection(
    sec: SectionEntity,
    blurhashes: Map<string, string | null>,
  ): NormalizedSection {
    const playlistJoins = sec.playlistJoins ?? [];
    return {
      id: sec.id,
      title: sec.title,
      description: sec.description,
      position: sec.position,
      itemsSize: sec.itemsSize,
      itemsRows: sec.itemsRows,
      transform: sec.transform,
      isDescriptionTitleOnSlideLarge: sec.isDescriptionTitleOnSlideLarge,
      whereIsSlideTitleLocated: sec.whereIsSlideTitleLocated,
      borderRadius: sec.borderRadius,
      playlists: playlistJoins.map((join) =>
        this.normalizeSectionPlaylist(join, blurhashes),
      ),
    };
  }

  private normalizeSectionPlaylist(
    join: SectionPlaylistJoinEntity,
    blurhashes: Map<string, string | null>,
  ): NormalizedPlaylist {
    const playlist = join.playlist;
    const sectionJoins = playlist.sectionJoins ?? [];
    const sermonJoins = playlist.sermonJoins ?? [];
    return {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description,
      artwork: playlist.artwork,
      artworkBlurhash: blurhashes.get(playlist.artwork) ?? null,
      position: join.position,
      sections: sectionJoins.map((sectionJoin) => ({
        id: sectionJoin.section.id,
        title: sectionJoin.section.title,
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
    };
  }
}
