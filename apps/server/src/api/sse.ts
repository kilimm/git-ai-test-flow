// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseMessage {
  id?: string | number;
  event: string;
  data: unknown;
}

export interface SsePollResult {
  messages: SseMessage[];
  terminal: boolean;
  /** 下一轮的非数字游标（例如 generation.updatedAt）。 */
  cursor?: string | number | null;
}

export interface SseStreamOptions {
  request: FastifyRequest;
  reply: FastifyReply;
  poll: (cursor: number | string | null) => Promise<SsePollResult>;
  initialCursor?: number | string | null;
  intervalMs?: number;
  heartbeatMs?: number;
  maxDurationMs?: number;
}

export function formatSseMessage(message: SseMessage): string {
  const id = message.id === undefined ? '' : `id: ${message.id}\n`;
  const data = typeof message.data === 'string' ? message.data : JSON.stringify(message.data ?? {});

  return `${id}event: ${message.event}\ndata: ${data}\n\n`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/**
 * 通用 SSE 流：按 Last-Event-ID 续传，空闲心跳，终态且无新事件后关闭。
 * 使用 raw socket 写入，客户端断开时停止轮询，避免定时器泄漏。
 */
export async function streamSse(options: SseStreamOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxDurationMs = options.maxDurationMs ?? 30 * 60_000;
  const startedAt = Date.now();
  let cursor = options.initialCursor ?? null;
  let lastWriteAt = Date.now();
  let closed = false;

  options.reply.hijack();
  options.reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  options.reply.raw.flushHeaders?.();

  const close = (): void => {
    closed = true;

    if (!options.reply.raw.writableEnded) {
      options.reply.raw.end();
    }
  };

  options.request.raw.on('close', close);
  options.request.raw.on('error', close);

  while (!closed && Date.now() - startedAt < maxDurationMs) {
    let result: SsePollResult;

    try {
      result = await options.poll(cursor);
    } catch (error) {
      // 内部错误可能包含 SQL、连接串等细节，只记录日志，客户端仅收到泛化消息。
      options.request.log.error({ err: error }, 'sse poll failed');

      if (!closed) {
        options.reply.raw.write(
          formatSseMessage({
            event: 'error',
            data: {
              code: 'SSE_POLL_FAILED',
              message: 'Failed to load updates, please retry',
            },
          }),
        );
      }

      break;
    }

    if (closed) {
      break;
    }

    for (const message of result.messages) {
      options.reply.raw.write(formatSseMessage(message));
      lastWriteAt = Date.now();
    }

    if (result.cursor !== undefined && result.cursor !== null) {
      cursor = result.cursor;
    }

    if (result.terminal && result.messages.length === 0) {
      break;
    }

    if (Date.now() - lastWriteAt >= heartbeatMs) {
      options.reply.raw.write(': heartbeat\n\n');
      lastWriteAt = Date.now();
    }

    await delay(intervalMs);
  }

  close();
  options.request.raw.removeListener('close', close);
  options.request.raw.removeListener('error', close);
}
