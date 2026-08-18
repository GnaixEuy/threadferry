export interface AttachmentMetadata {
  type: "image" | "file" | "voice" | "video";
  name?: string;
}

export interface QuoteMetadata {
  type: string;
  text?: string;
}

export interface GroupMessage {
  senderId: string;
  senderName?: string;
  time: Date;
  text: string;
  quote?: QuoteMetadata;
  attachments?: AttachmentMetadata[];
}

export interface IncomingMention extends GroupMessage {
  msgId: string;
  groupId: string;
  mentioned: boolean;
}

export interface IncomingDirectMessage {
  msgId: string;
  senderId: string;
  time: Date;
  text: string;
}

export type IncomingWecomEvent =
  | { chatType: "group"; message: IncomingMention }
  | { chatType: "single"; message: IncomingDirectMessage };

export interface DirectoryUser {
  id: string;
  name: string;
  alias?: string;
  departments?: string[];
  matchedKeywords?: string[];
}

export interface GroupConfig {
  workspace: string;
  runtime: "codex";
  allowUsers: string[];
  context: {
    lookbackHours: number;
    maxMessages: number;
  };
}

export interface WardenConfig {
  version: 4;
  ownerUser: string;
  groups: Record<string, GroupConfig>;
  security: {
    requireMention: true;
    readOnly: true;
  };
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type Reply = (content: string, finish?: boolean) => Promise<void>;

export interface RuntimeResult {
  text: string;
  sessionId?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;
