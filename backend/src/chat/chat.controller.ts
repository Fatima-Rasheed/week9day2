import { Controller, Post, Get, Delete, Body, Param } from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ChatService } from './chat.service';

class AskQuestionDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsOptional()
  userId?: string;
}

@Controller()
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /** POST /ask — run the full LangGraph workflow with memory */
  @Post('ask')
  async ask(@Body() dto: AskQuestionDto) {
    return this.chatService.processQuestion(dto.question, dto.userId ?? 'anonymous');
  }

  /** GET /history/:userId — return conversation history for a user */
  @Get('history/:userId')
  async getHistory(@Param('userId') userId: string) {
    const history = await this.chatService.getHistory(userId);
    return { success: true, userId, history };
  }

  /** GET /summary/:userId — return the compressed memory summary for a user */
  @Get('summary/:userId')
  async getSummary(@Param('userId') userId: string) {
    const summary = await this.chatService.getMemorySummary(userId);
    return { success: true, userId, summary };
  }

  /** DELETE /memory/:userId — wipe all conversation history and summary for a user */
  @Delete('memory/:userId')
  async clearMemory(@Param('userId') userId: string) {
    const result = await this.chatService.clearMemory(userId);
    return { success: true, userId, ...result };
  }
}
