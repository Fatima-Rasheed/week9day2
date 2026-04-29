import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { LangGraphService } from './langgraph.service';

@Module({
  controllers: [ChatController],
  providers: [ChatService, LangGraphService],
})
export class ChatModule {}
