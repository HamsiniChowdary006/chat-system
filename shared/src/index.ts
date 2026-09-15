export type UserId = string;
export type DeviceId = string;
export type ConversationId = string;
export type MessageId = number;

export interface ChatMessage {
  conversationId: ConversationId;
  messageId: MessageId;
  senderId: UserId;
  body: string;
  createdAt: string;
}

export interface ServiceEndpoint {
  serviceId: string;
  host: string;
  port: number;
}
