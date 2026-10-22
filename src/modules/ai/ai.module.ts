import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiLlmModel } from './entities/ai-llm-model.entity';
import { AiChatbot } from './entities/ai-chatbot.entity';
import { AiRagModel, AiRagDocument } from './entities/ai-rag-model.entity';
import { AiMcpConnection } from './entities/ai-mcp-connection.entity';
import { AiChatOverride } from './entities/ai-chat-override.entity';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { AiLlmModelsService } from './ai-llm-models.service';
import { AiChatbotService } from './ai-chatbot.service';
import { AiRagService } from './ai-rag.service';
import { AiMcpConnectionsService } from './ai-mcp-connections.service';
import { AuditModule } from '../audit/audit.module';
import { AiLlmModelController } from './ai-llm-model.controller';
import { AiChatbotController, AiIntegrationController } from './ai-chatbot.controller';
import { AiRagModelController } from './ai-rag-model.controller';
import { AiMcpConnectionController } from './ai-mcp-connection.controller';

/**
 * AI Integration: LLM provider connections, chatbot instances, vectorless RAG models and outbound
 * MCP server connections.
 * Deliberately imports no feature module: SessionModule imports this one (the projector fires the
 * chatbot evaluation), so anything imported here must not lead back to SessionModule. The Session
 * and Message ENTITIES are registered here for the same reason the automation module registers the
 * Session entity: a repository needs only the entity, while importing SessionModule (or
 * MessageModule, which imports SessionModule) would close that cycle.
 *
 * AuditModule is imported for the audit sink; it owns no session/module-cycle edge.
 */
@Module({
  imports: [
    AuditModule,
    TypeOrmModule.forFeature([AiLlmModel, AiChatbot, AiChatOverride, AiRagModel, AiRagDocument, AiMcpConnection, Session, Message], 'data'),
  ],
  controllers: [
    AiLlmModelController,
    AiChatbotController,
    AiIntegrationController,
    AiRagModelController,
    AiMcpConnectionController,
  ],
  providers: [AiLlmModelsService, AiChatbotService, AiRagService, AiMcpConnectionsService],
  exports: [AiLlmModelsService, AiChatbotService, AiRagService, AiMcpConnectionsService],
})
export class AiModule {}
