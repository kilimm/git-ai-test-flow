// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LlmProviderError,
  StructuredOutputError,
  createLlmClient,
  extractJson,
  generateStructured,
} from '../src/llm/llm-client.js';
import type { LlmClient } from '../src/llm/llm-client.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fetchJson(body: unknown, calls: Call[], status = 200): typeof fetch {
  return async (url, init) => {
    calls.push({ url: String(url), init });

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('llm provider clients', () => {
  it('calls OpenAI-compatible chat completions with JSON mode', async () => {
    const calls: Call[] = [];
    const client = createLlmClient({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test',
      apiKey: 'sk-secret',
      fetchImpl: fetchJson(
        {
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        },
        calls,
      ),
    });

    const result = await client.generate({ system: 'system', user: 'user' });
    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, model: 'gpt-test' });
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer sk-secret');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: 'gpt-test',
      response_format: { type: 'json_object' },
    });
  });

  it('calls Anthropic and Gemini with their native auth headers', async () => {
    const anthropicCalls: Call[] = [];
    const anthropic = createLlmClient({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      apiKey: 'anthropic-key',
      fetchImpl: fetchJson(
        {
          content: [{ type: 'text', text: '{"ok":1}' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
        anthropicCalls,
      ),
    });
    const anthropicResult = await anthropic.generate({ system: 's', user: 'u' });
    expect(anthropicResult.text).toBe('{"ok":1}');
    expect(anthropicResult.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      model: 'claude-test',
    });
    expect(anthropicCalls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(anthropicCalls[0]?.init?.headers).get('x-api-key')).toBe('anthropic-key');
    expect(new Headers(anthropicCalls[0]?.init?.headers).get('anthropic-version')).toBe(
      '2023-06-01',
    );

    const geminiCalls: Call[] = [];
    const gemini = createLlmClient({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-test',
      apiKey: 'gemini-key',
      fetchImpl: fetchJson(
        {
          candidates: [{ content: { parts: [{ text: '{"ok":2}' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 },
        },
        geminiCalls,
      ),
    });
    const geminiResult = await gemini.generate({ system: 's', user: 'u' });
    expect(geminiResult.text).toBe('{"ok":2}');
    expect(geminiResult.usage).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      model: 'gemini-test',
    });
    expect(geminiCalls[0]?.url).toContain('/v1beta/models/gemini-test:generateContent');
    expect(new Headers(geminiCalls[0]?.init?.headers).get('x-goog-api-key')).toBe('gemini-key');
  });

  it('maps HTTP, network and response-shape failures to stable errors', async () => {
    const httpClient = createLlmClient({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-test',
      fetchImpl: fetchJson({ error: 'bad request' }, [], 400),
    });
    await expect(httpClient.generate({ system: 's', user: 'u' })).rejects.toMatchObject({
      code: 'LLM_HTTP_ERROR',
    });

    const networkClient = createLlmClient({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-test',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(networkClient.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
      LlmProviderError,
    );

    const emptyClient = createLlmClient({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'model',
      fetchImpl: fetchJson({ choices: [] }, []),
    });
    await expect(emptyClient.generate({ system: 's', user: 'u' })).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });
});

describe('structured output', () => {
  it('extracts JSON from fenced or surrounded text', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('prefix {"a":[1,2]} suffix')).toEqual({ a: [1, 2] });
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(() => extractJson('no json here')).toThrow(StructuredOutputError);
  });

  it('repairs one invalid structured response', async () => {
    let calls = 0;
    const client: LlmClient = {
      async generate() {
        calls += 1;

        return {
          text: calls === 1 ? '{"wrong":true}' : '{"features":[]}',
          usage: { inputTokens: 1, outputTokens: 1, model: 'fake' },
        };
      },
    };
    const schema = z.object({ features: z.array(z.string()) }).strict();
    const result = await generateStructured(client, schema, { system: 's', user: 'u' });

    expect(result.value).toEqual({ features: [] });
    expect(result.repairs).toBe(1);
    expect(result.usages).toHaveLength(2);
  });

  it('throws after the repair attempt still fails', async () => {
    const client: LlmClient = {
      async generate() {
        return {
          text: '{"wrong":true}',
          usage: { inputTokens: 1, outputTokens: 1, model: 'fake' },
        };
      },
    };
    const schema = z.object({ features: z.array(z.string()) }).strict();

    await expect(
      generateStructured(client, schema, { system: 's', user: 'u' }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});
