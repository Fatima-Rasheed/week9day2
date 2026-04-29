import { Controller, Post, Body } from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { ChatService } from './chat.service';

class AskQuestionDto {
  @IsString()
  @IsNotEmpty()
  question: string;
}

@Controller()
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('ask')
  async ask(@Body() dto: AskQuestionDto) {
    return this.chatService.processQuestion(dto.question);
  }
}
