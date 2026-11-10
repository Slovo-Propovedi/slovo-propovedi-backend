import { Module } from '@nestjs/common';
import { PlaylistService } from './playlist.service';
import { PlaylistController } from './playlist.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlaylistEntity } from './entities/playlist.entity';
import { PlaylistSermonJoinEntity } from './entities/playlist-sermon-join.entity';
import { SectionEntity } from 'src/section/entities/section.entity';
import { SectionPlaylistJoinEntity } from 'src/section/entities/section-playlist-join.entity';
import { SermonModule } from 'src/sermon/sermon.module';
import { PicturesModule } from 'src/pictures/pictures.module';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlaylistEntity,
      SectionEntity,
      SectionPlaylistJoinEntity,
      PlaylistSermonJoinEntity,
    ]),
    SermonModule,
    PicturesModule,
    // AuthGuard re-checks the live user (role/token_version) on every request.
    UsersModule,
  ],
  controllers: [PlaylistController],
  providers: [PlaylistService],
  exports: [PlaylistService],
})
export class PlaylistModule {}
