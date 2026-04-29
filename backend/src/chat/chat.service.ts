import { Injectable } from '@nestjs/common';
import { LangGraphService } from './langgraph.service';

@Injectable()
export class ChatService {
  constructor(private readonly langGraphService: LangGraphService) {}

  async processQuestion(question: string) {
    try {
      const result = await this.langGraphService.runWorkflow(question);
      return {
        success: true,
        answer: result.answer,
        type: result.type,
      };
    } catch (error) {
      return {
        success: false,
        answer: 'Sorry, I encountered an error processing your question.',
        type: 'text',
        error: error.message,
      };
    }
  }
}
