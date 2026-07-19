'use strict';

const logger = require('./logger');

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compactUsage(usage = {}) {
  const normalized = {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    reasoningTokens: finiteNumber(usage.reasoningTokens),
    cachedInputTokens: finiteNumber(usage.cachedInputTokens),
    totalTokens: finiteNumber(usage.totalTokens)
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined)
  );
}

function extractOpenAIUsage(usage = {}) {
  return compactUsage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
    totalTokens: usage.total_tokens
  });
}

function extractGeminiUsage(usage = {}) {
  return compactUsage({
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
    cachedInputTokens: usage.cachedContentTokenCount,
    totalTokens: usage.totalTokenCount
  });
}

function recordAiCall({
  outcome,
  provider,
  operation,
  model,
  promptVersion,
  attempt = 1,
  maxAttempts = 1,
  startedAt,
  durationMs,
  retryScheduled = false,
  parseResult = 'not_applicable',
  schemaResult = 'not_applicable',
  usage = {},
  responseId,
  finishReason,
  errorCode,
  errorStatus
}) {
  const safeOutcome = outcome === 'failed' ? 'failed' : 'completed';
  const elapsed = finiteNumber(durationMs)
    ?? (finiteNumber(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined);

  const fields = {
    provider,
    operation,
    model,
    promptVersion,
    attempt,
    maxAttempts,
    retryCount: Math.max(0, attempt - 1),
    retryScheduled: Boolean(retryScheduled),
    durationMs: elapsed,
    parseResult,
    schemaResult,
    usage: compactUsage(usage),
    responseId,
    finishReason,
    errorCode,
    errorStatus: finiteNumber(errorStatus)
  };

  const write = safeOutcome === 'failed' ? logger.warn : logger.info;
  return write(`ai.provider_call.${safeOutcome}`, fields);
}

module.exports = {
  compactUsage,
  extractOpenAIUsage,
  extractGeminiUsage,
  recordAiCall
};
