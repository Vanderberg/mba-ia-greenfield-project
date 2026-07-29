import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { TusUploadMiddleware } from './tus-upload.middleware';
import { TusUploadService } from './tus-upload.service';

@Module({
  imports: [AuthModule, StorageModule, QueueModule, VideosModule],
  providers: [TusUploadService, TusUploadMiddleware],
})
export class UploadsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TusUploadMiddleware).forRoutes('uploads', 'uploads/*path');
  }
}
