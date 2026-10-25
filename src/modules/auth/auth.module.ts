import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { Account } from './entities/account.entity';
import { User } from './entities/user.entity';
import { Plan } from './entities/plan.entity';
import { AuthService } from './auth.service';
import { AccountsService } from './accounts.service';
import { UsersService } from './users.service';
import { PlansService } from './plans.service';
import { PlanLimitsService } from './plan-limits.service';
import { SessionTokenService } from './session-token.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ChatScopeService } from './chat-scope.service';
import { ActiveKeyIndex } from './active-key-index';
import { AuthController } from './auth.controller';
import { AccountsController } from './accounts.controller';
import { SaasAuthController } from './saas-auth.controller';
import { PlatformController } from './platform.controller';
import { AuthValidateController } from './auth-validate.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, Account, User, Plan], 'main')],
  controllers: [AuthController, AccountsController, SaasAuthController, PlatformController, AuthValidateController],
  providers: [
    AuthService,
    AccountsService,
    UsersService,
    PlansService,
    PlanLimitsService,
    SessionTokenService,
    ApiKeyUsageTracker,
    ChatScopeService,
    ActiveKeyIndex,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [
    AuthService,
    AccountsService,
    UsersService,
    PlansService,
    PlanLimitsService,
    SessionTokenService,
    ChatScopeService,
    ActiveKeyIndex,
  ],
})
export class AuthModule {}
