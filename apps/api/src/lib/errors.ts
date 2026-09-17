import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError, type ErrorCode, type ErrorEnvelope } from '@confluo/shared';

function envelope(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorEnvelope {
  return { error: { code, message, details, requestId } };
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(envelope('NOT_FOUND', `Route ${request.method} ${request.url} not found`, request.id));
  });

  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    const rid = request.id;
    if (error instanceof AppError) {
      reply.status(error.status).send(envelope(error.code, error.message, rid, error.details));
      return;
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply
        .status(400)
        .send(envelope('VALIDATION_FAILED', 'Request validation failed', rid, { issues: error.validation }));
      return;
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response serialization failed');
      reply.status(500).send(envelope('INTERNAL', 'Response serialization failed', rid));
      return;
    }
    const fe = error as FastifyError;
    if (fe.statusCode === 429) {
      reply.status(429).send(envelope('RATE_LIMITED', 'Too many requests', rid));
      return;
    }
    if (fe.statusCode === 413 || fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.status(413).send(envelope('PAYLOAD_TOO_LARGE', 'Payload too large', rid));
      return;
    }
    if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      reply.status(415).send(envelope('UNSUPPORTED_MEDIA', 'Unsupported media type', rid));
      return;
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      reply.status(fe.statusCode).send(envelope('VALIDATION_FAILED', fe.message, rid));
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send(envelope('INTERNAL', 'Internal server error', rid));
  });
}
