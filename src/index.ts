export { startProxy } from "./proxy.js";
export type { ProxyOptions, RunningProxy } from "./proxy.js";
export {
  didMemtreeCompress,
  MemtreeClient,
  rawPromptTokenCount,
} from "./memtree.js";
export type { MemtreeOptions, CompressResult } from "./memtree.js";
export {
  isNonToolUserMessage,
  isAwaySummaryUserMessage,
  AWAY_SUMMARY_PROMPT_PREFIX,
  lastNonSystemMessage,
  userMessageText,
  hasEarlierNonToolUserMessage,
  stripCcSystemReminders,
  flattenToSingleUserMessage,
  messagesWithSystem,
  contextLimitForModel,
} from "./turns.js";
export type { Message } from "./turns.js";
export {
  NOTICE_OPEN,
  NOTICE_CLOSE,
  COMPRESSED_NOTICE,
  MODEL_HIDDEN_NOTICE,
  DEGRADED_NOTICE,
  PAYMENT_REQUIRED_NOTICE,
  SLOW_FIRST_TOKEN_NOTICE,
  compressedNoticeText,
  sanitizeNoticeDetail,
  wrapNotice,
  exciseKnownLegacyNoticeSpans,
  stripNoticeBlocks,
  stripNoticeSystem,
  SseNoticeRewriter,
  fabricatedPrelude,
  insertNoticeBeforeResponseContent,
  appendNoticeToJsonBody,
} from "./notices.js";
export type { CompressionNoticeMetrics } from "./notices.js";
export {
  NoticeDeliveryQueue,
  parseNoticeHookInput,
  createSessionNoticePlugin,
  supportsMessageDisplay,
  terminalSupportsColor,
  withSessionNoticePluginArgs,
  MESSAGE_DISPLAY_MIN_VERSION,
} from "./hooks.js";
export type {
  NoticeHookInput,
  NoticeHookOutput,
  SessionNoticePlugin,
} from "./hooks.js";
export {
  projectTranscriptDir,
  startTranscriptScrubber,
  scrubLineInPlace,
} from "./scrub.js";
export type { TranscriptScrubber, ScrubberOptions } from "./scrub.js";

// Keychain access is the designed-but-unbuilt fallback in case Anthropic stops
// sending OAuth to custom base URLs (plan: "Auth to Anthropic"). Not used by
// the launcher — Claude Code owns its credentials.
export { getOAuthToken, isTokenExpired } from "./keychain.js";
export type { ClaudeOAuthToken, KeychainCredentials } from "./keychain.js";
