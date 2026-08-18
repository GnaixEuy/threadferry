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

export type RuntimeName = "codex" | "pi";

export interface AgentConfig {
  workspace: string;
  runtime: RuntimeName;
  model?: string;
}

export interface GroupConfig {
  agent: string;
  allowUsers: string[];
  context: {
    lookbackHours: number;
    maxMessages: number;
  };
}

export interface WardenConfig {
  version: 5;
  ownerUser: string;
  agents: Record<string, AgentConfig>;
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

export interface RuntimeRequest extends AgentConfig {
  agentId: string;
  prompt: string;
  sessionId?: string;
  signal?: AbortSignal;
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
