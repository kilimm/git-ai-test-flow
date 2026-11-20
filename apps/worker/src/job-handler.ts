// 本文件所有改动要求遵循 agent-rules 规范
import type { Job } from '@gait/db';

export interface JobExecutionContext {
  readonly job: Job;
  readonly payload: unknown;
  readonly workerId: string;
  /** 租约丢失时触发，handler 应尽快停止并抛出 AbortError。 */
  readonly signal: AbortSignal;
}

export type JobHandler = (context: JobExecutionContext) => Promise<void> | void;

export class DuplicateJobHandlerError extends Error {
  constructor(type: string) {
    super(`A handler is already registered for job type: ${type}`);
    this.name = 'DuplicateJobHandlerError';
  }
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(type: string, handler: JobHandler): this {
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new TypeError('Job type must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new TypeError('Job handler must be a function');
    }

    if (this.handlers.has(type)) {
      throw new DuplicateJobHandlerError(type);
    }

    this.handlers.set(type, handler);
    return this;
  }

  resolve(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }
}
