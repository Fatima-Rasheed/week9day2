import { Injectable } from '@nestjs/common';
import { LangGraphService, ConversationEntry, MemorySummary } from './langgraph.service';

@Injectable()
export class ChatService {
  constructor(private readonly langGraphService: LangGraphService) {}

  async processQuestion(question: string, userId = 'anonymous') {
    try {
      const result = await this.langGraphService.runWorkflow(question, userId);
      return {
        success: true,
        answer: result.answer,
        type: result.type,
        memoryUsed: result.memoryUsed,
      };
    } catch (error) {
      return {
        success: false,
        answer: 'Sorry, I encountered an error processing your question.',
        type: 'text',
        memoryUsed: false,
        error: error.message,
      };
    }
  }

  async getHistory(userId: string): Promise<ConversationEntry[]> {
    return this.langGraphService.getHistory(userId);
  }

  async getMemorySummary(userId: string): Promise<MemorySummary | null> {
    return this.langGraphService.getMemorySummary(userId);
  }

  async clearMemory(userId: string): Promise<{ deleted: number }> {
    return this.langGraphService.clearMemory(userId);
  }
}
