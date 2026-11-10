import { Module } from '@nestjs/common';
import { SectionService } from './section.service';
import { SectionController } from './section.controller';
import { SectionEntity } from './entities/section.entity';
import { SectionPlaylistJoinEntity } from './entities/section-playlist-join.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlaylistModule } from 'src/playlist/playlist.module';
import { PicturesModule } from 'src/pictures/pictures.module';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SectionEntity, SectionPlaylistJoinEntity]),
    PlaylistModule,
    PicturesModule,
    // AuthGuard re-checks the live user (role/token_version) on every request.
    UsersModule,
  ],
  controllers: [SectionController],
  providers: [SectionService],
})
export class SectionModule {}
