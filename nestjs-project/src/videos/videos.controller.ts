import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { JwtPayload } from '../auth/auth.types';
import { StorageService } from '../storage/storage.service';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pre-register a video draft',
    description:
      'Creates a draft Video row before any upload byte is sent, deriving its storage key from the generated id.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'draft' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createDraft(
    @CurrentUser() user: JwtPayload,
  ): Promise<{ id: string; status: string }> {
    const video = await this.videosService.createDraftForUser(user.sub);
    return { id: video.id, status: video.status };
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  @ApiOperation({
    summary: 'Get a video by id',
    description:
      'Returns the video status and metadata. Non-owners may only see it once status is "ready".',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found and visible to the requester',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string' },
        title: { type: 'string', nullable: true },
        durationSeconds: { type: 'number', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Video is not ready and the requester is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<{
    id: string;
    status: string;
    title: string | null;
    durationSeconds: number | null;
    thumbnailUrl: string | null;
  }> {
    const video = await this.videosService.findVisibleById(id, user?.sub);

    const thumbnailUrl =
      video.status === 'ready' && video.thumbnail_key
        ? await this.storageService.getPresignedUrl(video.thumbnail_key)
        : null;

    return {
      id: video.id,
      status: video.status,
      title: video.title,
      durationSeconds: video.duration_seconds,
      thumbnailUrl,
    };
  }
}
