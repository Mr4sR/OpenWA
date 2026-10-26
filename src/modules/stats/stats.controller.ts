import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MessageStatsResponseDto, OverviewStatsResponseDto, SessionStatsResponseDto } from './dto/stats-response.dto';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';
import { AllowAccountKeys, CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('statistics')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  // Cross-session aggregates carry no :sessionId, so the route-param fence cannot scope them;
  // @AllowAccountKeys admits a tenant principal and the SERVICE scopes every count to the caller's
  // account (a session-restricted key stays refused — it is not account-wide).
  @Get('overview')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @AllowAccountKeys()
  @ApiOperation({ summary: 'Get overall statistics for the calling account' })
  @ApiResponse({
    status: 200,
    description: 'Cross-session aggregate statistics (sessions, messages, etc.) of the caller’s account.',
    type: OverviewStatsResponseDto,
  })
  async getOverview(@CurrentApiKey() apiKey?: ApiKey) {
    return this.statsService.getOverview(apiKey?.accountId ?? null);
  }

  @Get('messages')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @AllowAccountKeys()
  @ApiOperation({ summary: 'Get message statistics with time series for the calling account' })
  @ApiResponse({
    status: 200,
    description: 'Message statistics with a time series for the requested period, scoped to the caller’s account.',
    type: MessageStatsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'A query value is invalid, or the query carries a field the DTO does not declare.',
  })
  async getMessageStats(@Query() query: StatsQueryDto, @CurrentApiKey() apiKey?: ApiKey) {
    return this.statsService.getMessageStats(query.period || '24h', apiKey?.accountId ?? null);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get statistics for a specific session' })
  @ApiResponse({
    status: 200,
    description: 'Per-session statistics for the requested session.',
    type: SessionStatsResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getSessionStats(@Param('sessionId') sessionId: string) {
    return this.statsService.getSessionStats(sessionId);
  }
}
