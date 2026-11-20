// 本文件所有改动要求遵循 agent-rules 规范
// SSRF 守卫已下沉到 @gait/config，供 Server 与 Runner 共用；此处保留兼容导出。
export {
  BlockedTargetError,
  DnsResolutionError,
  UrlSafetyChecker,
  isBlockedAddress,
  isHostAllowlisted,
} from '@gait/config';
export type {
  DnsLookup,
  DnsLookupResult,
  UrlSafetyCheckOptions,
  UrlSafetyOptions,
} from '@gait/config';
