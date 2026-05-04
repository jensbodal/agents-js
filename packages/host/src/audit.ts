import type {
  AuditEmitter,
  AuditEvent,
  AuditEventInput,
  AuditLogger,
  CorrelationId,
} from "@agents-js/a2a/audit";
import {
  _AUDIT_EVENT_NO_SENSITIVE_PAYLOAD as a2aAuditEventNoSensitivePayload,
  createAuditEmitter as createA2aAuditEmitter,
  newCorrelationId as newA2aCorrelationId,
} from "@agents-js/a2a/audit";

export type { AuditEmitter, AuditEvent, AuditEventInput, AuditLogger, CorrelationId };

export const _AUDIT_EVENT_NO_SENSITIVE_PAYLOAD = a2aAuditEventNoSensitivePayload;
export const createAuditEmitter = createA2aAuditEmitter;
export const newCorrelationId = newA2aCorrelationId;
