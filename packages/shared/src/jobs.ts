// 本文件所有改动要求遵循 agent-rules 规范

/** 任务状态机：queued → running → succeeded / failed；失败后可按策略回到 queued。 */
export const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** M1 仅用于验证 Worker 消费链路，没有业务副作用。 */
export const JOB_TYPE_NOOP = 'noop';

/** 生成任务（M4）。 */
export const JOB_TYPE_GENERATION = 'generation.run';

/** 测试运行任务（M5）。 */
export const JOB_TYPE_RUN = 'run.execute';

/** 文档同步/增量/压缩任务（M9）。 */
export const JOB_TYPE_DOC_SYNC = 'doc.sync';

/** 定时触发器处理任务（M9）。 */
export const JOB_TYPE_SCHEDULE = 'trigger.schedule';
