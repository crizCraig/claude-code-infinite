export { startProxy } from "./proxy.js";
export type { ProxyOptions, RunningProxy } from "./proxy.js";
export { MemtreeClient } from "./memtree.js";
export type { MemtreeOptions, CompressResult } from "./memtree.js";
export {
  isNonToolUserMessage,
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
  DEGRADED_NOTICE,
  SLOW_FIRST_TOKEN_NOTICE,
  wrapNotice,
  stripNoticeBlocks,
  SseNoticeRewriter,
  fabricatedPrelude,
  appendNoticeToJsonBody,
} from "./notices.js";
export {
  projectTranscriptDir,
  startTranscriptScrubber,
  sweepTranscripts,
  scrubLineInPlace,
} from "./scrub.js";
export type { TranscriptScrubber, ScrubberOptions } from "./scrub.js";

// Keychain access is the designed-but-unbuilt fallback in case Anthropic stops
// sending OAuth to custom base URLs (plan: "Auth to Anthropic"). Not used by
// the launcher — Claude Code owns its credentials.
export { getOAuthToken, isTokenExpired } from "./keychain.js";
export type { ClaudeOAuthToken, KeychainCredentials } from "./keychain.js";
