// 本文件所有改动要求遵循 agent-rules 规范
import type { JobHandler } from './job-handler.js';

/** 空任务处理器：验证领取、心跳、完成链路，不产生任何业务副作用。 */
export const noopJobHandler: JobHandler = ({ signal }) => {
  signal.throwIfAborted();
};
