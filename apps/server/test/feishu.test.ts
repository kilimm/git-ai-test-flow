// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  buildFeishuTestCard,
  createFeishuSignature,
  parseFeishuResponse,
} from '../src/config/feishu.js';

describe('feishu signature', () => {
  it('matches the documented HMAC formula', () => {
    expect(createFeishuSignature(1_599_360_473, 'test-secret')).toBe(
      'wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=',
    );
    expect(createFeishuSignature(1_599_360_474, 'test-secret')).not.toBe(
      createFeishuSignature(1_599_360_473, 'test-secret'),
    );
  });
});

describe('feishu test card', () => {
  it('contains only non-sensitive project and channel metadata', () => {
    const card = buildFeishuTestCard({
      projectName: 'Demo',
      channelName: 'Release',
      triggeredAt: 1_700_000_000_000,
    });
    const json = JSON.stringify(card);

    expect(json).toContain('Demo');
    expect(json).toContain('Release');
    expect(json).toContain('2023-11-14T22:13:20.000Z');
    expect(json).not.toContain('secret');
  });
});

describe('feishu response parsing', () => {
  it('accepts both success response shapes', () => {
    expect(parseFeishuResponse(200, '{"code":0,"msg":"success"}')).toMatchObject({
      ok: true,
      code: 'OK',
    });
    expect(parseFeishuResponse(200, '{"StatusCode":0,"StatusMessage":"success"}')).toMatchObject({
      ok: true,
    });
  });

  it('rejects API errors, HTTP errors and invalid payloads', () => {
    expect(parseFeishuResponse(200, '{"code":19001,"msg":"invalid"}')).toMatchObject({
      ok: false,
      code: 'FEISHU_API_ERROR',
    });
    expect(parseFeishuResponse(500, '{"msg":"server error"}')).toMatchObject({
      ok: false,
      code: 'HTTP_ERROR',
    });
    expect(parseFeishuResponse(200, 'not-json')).toMatchObject({
      ok: false,
      code: 'INVALID_RESPONSE',
    });
    expect(parseFeishuResponse(200, 'null')).toMatchObject({
      ok: false,
      code: 'INVALID_RESPONSE',
    });
    expect(parseFeishuResponse(503, '{}')).toMatchObject({
      ok: false,
      code: 'HTTP_ERROR',
    });
  });
});
