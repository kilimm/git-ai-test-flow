import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { NotFoundError, toProblemDetails, ValidationError } from '../src/errors.js';

describe('problem details', () => {
  it('serializes AppError without leaking the stack', () => {
    const problem = new NotFoundError('Project not found').toProblem('/api/v1/projects/42');

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Project not found',
      instance: '/api/v1/projects/42',
      code: 'NOT_FOUND',
    });
    expect(problem).not.toHaveProperty('stack');
  });

  it('includes validation issues', () => {
    const problem = new ValidationError('Request validation failed', [
      { path: 'name', message: 'Required', code: 'invalid_type' },
    ]);

    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual([{ path: 'name', message: 'Required', code: 'invalid_type' }]);
  });

  it('maps ZodError to a 400 problem', () => {
    const result = z.object({ name: z.string().min(3) }).safeParse({ name: 'x' });

    expect(result.success).toBe(false);

    if (!result.success) {
      const problem = toProblemDetails(result.error);
      expect(problem.status).toBe(400);
      expect(problem.code).toBe('VALIDATION_ERROR');
      expect(problem.errors?.[0]?.path).toBe('name');
    }
  });

  it('hides unexpected error details', () => {
    const problem = toProblemDetails(new Error('database password=super-secret'));

    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).not.toContain('super-secret');
  });
});
