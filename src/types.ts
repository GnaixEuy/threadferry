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

export const RUNTIME_NAMES = ["codex", "pi", "claude", "grok"] as const;
export type RuntimeName = typeof RUNTIME_NAMES[number];

export function isRuntimeName(value: string): value is RuntimeName {
  return RUNTIME_NAMES.includes(value as RuntimeName);
}

export interface AgentConfig {
  workspace: string;
  runtime: RuntimeName;
  model?: string;
  /** 该 Agent 机器人下的 Owner 回调 userid。换企业后同一个人的 userid 不同，所以按 Agent 存。 */
  ownerUser: string;
  /** 该 Agent 机器人凭据目录的显式覆盖；缺省由 agentId 推导（见 src/bots.ts）。 */
  configDir?: string;
}

/** 新建 Agent 时还不知道它自己机器人下的 Owner，由调用方补齐（配对时用配对者，新增时继承）。 */
export type AgentDefinition = Omit<AgentConfig, "ownerUser">;

/** 一个 Agent 在某个群里的授权。群里有几台 ThreadFerry 机器人，这个群下面就有几份。 */
export interface GroupAccess {
  allowUsers: string[];
  allowAll?: boolean;
}

/**
 * 全量配置里的一个群。授权按 Agent 分开记——同一个群里可以同时启用多台机器人，
 * @谁谁回答，各自用各自的 Workspace、Session 和授权名单。context 是取历史的窗口，整个群共用。
 */
export interface GroupBinding {
  agents: Record<string, GroupAccess>;
  context: {
    lookbackHours: number;
    maxMessages: number;
  };
}

/** 单 Agent 运行视图里的群：一个群只对应它自己那一份授权。 */
export interface GroupConfig {
  agent: string;
  allowUsers: string[];
  allowAll?: boolean;
  context: {
    lookbackHours: number;
    maxMessages: number;
  };
}

export interface ThreadFerryConfig {
  /** 磁盘格式版本。只接受 v6。 */
  version: 6;
  ownerUser: string;
  agents: Record<string, AgentConfig>;
  groups: Record<string, GroupBinding>;
  security: {
    requireMention: true;
    readOnly: true;
  };
}

/**
 * 运行时视图：只含一个 Agent 和它在各群里的那份授权。`createApp` 消费的是这个形状，
 * 所以「一个群挂多个 Agent」对 app.ts 完全透明——每个 app 实例眼里群仍然只归自己。
 */
export interface AgentView {
  version: 6;
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

// Runtime 只需要 workspace / runtime / model；Owner 与凭据目录跟它无关，所以继承
// AgentDefinition 而不是 AgentConfig，避免把身份信息带进 Runtime 边界。
export interface RuntimeRequest extends Omit<AgentDefinition, "configDir"> {
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
