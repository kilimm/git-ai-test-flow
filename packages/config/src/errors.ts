import { ZodError } from 'zod';

export interface ProblemIssue {
  path: string;
  message: string;
  code: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: ProblemIssue[];
}

const DEFAULT_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

export interface AppErrorOptions {
  code: string;
  status?: number;
  title?: string;
  detail?: string;
  type?: string;
  errors?: ProblemIssue[];
  cause?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly type: string;
  readonly detail: string | undefined;
  readonly errors: ProblemIssue[] | undefined;

  constructor(message: string, options: AppErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? 500;
    this.code = options.code;
    this.title = options.title ?? DEFAULT_TITLES[this.status] ?? 'Error';
    this.type = options.type ?? 'about:blank';
    this.detail = options.detail;
    this.errors = options.errors;
  }

  toProblem(instance?: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: this.type,
      title: this.title,
      status: this.status,
      code: this.code,
    };

    if (this.detail !== undefined) {
      problem.detail = this.detail;
    }

    if (instance !== undefined) {
      problem.instance = instance;
    }

    if (this.errors !== undefined) {
      problem.errors = this.errors;
    }

    return problem;
  }
}

export class ValidationError extends AppError {
  constructor(detail: string, errors?: ProblemIssue[]) {
    super(detail, {
      status: 400,
      code: 'VALIDATION_ERROR',
      detail,
      ...(errors === undefined ? {} : { errors }),
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication required') {
    super(detail, { status: 401, code: 'UNAUTHORIZED', detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'Access denied') {
    super(detail, { status: 403, code: 'FORBIDDEN', detail });
  }
}

export class NotFoundError extends AppError {
  constructor(detail = 'Resource not found') {
    super(detail, { status: 404, code: 'NOT_FOUND', detail });
  }
}

export class ConflictError extends AppError {
  constructor(detail = 'Resource conflict') {
    super(detail, { status: 409, code: 'CONFLICT', detail });
  }
}

export class RateLimitError extends AppError {
  constructor(detail = 'Too many requests') {
    super(detail, { status: 429, code: 'RATE_LIMITED', detail });
  }
}

export class InternalServerError extends AppError {
  constructor(detail = 'An unexpected error occurred') {
    super(detail, { status: 500, code: 'INTERNAL_ERROR', detail });
  }
}

export function toProblemDetails(error: unknown, instance?: string): ProblemDetails {
  if (error instanceof AppError) {
    return error.toProblem(instance);
  }

  if (error instanceof ZodError) {
    const problem: ProblemDetails = {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'VALIDATION_ERROR',
      detail: 'Request validation failed',
      errors: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
        code: issue.code,
      })),
    };

    if (instance !== undefined) {
      problem.instance = instance;
    }

    return problem;
  }

  const problem: ProblemDetails = {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    code: 'INTERNAL_ERROR',
    detail: 'An unexpected error occurred',
  };

  if (instance !== undefined) {
    problem.instance = instance;
  }

  return problem;
}
