'use strict';

const KNOWN_CODES = [
  'DAILY_LIMIT',
  'INSUFFICIENT_CREDITS',
  'USER_NOT_FOUND',
  'OPERATION_MISMATCH',
  'OPERATION_NOT_FOUND',
  'OPERATION_NOT_RESERVED',
  'INVALID_OPERATION_ID',
  'INVALID_CREDIT_AMOUNT',
  'INVALID_ANALYSIS_RESULT'
];

function normalizeRpcResult(data) {
  return Array.isArray(data) ? data[0] : data;
}

function wrapRpcError(error, fallbackCode) {
  const message = String(error?.message || fallbackCode);
  const knownCode = KNOWN_CODES.find((code) => message.includes(code));
  const wrapped = new Error(message);
  wrapped.code = knownCode || fallbackCode;
  wrapped.cause = error;
  return wrapped;
}

async function reserveAnalysisOperation(client, {
  operationId,
  userId,
  creditCost,
  reservationSeconds = 900
}) {
  const { data, error } = await client.rpc('reserve_analysis_operation', {
    p_operation_id: operationId,
    p_user_id: userId,
    p_credit_cost: creditCost,
    p_reservation_seconds: reservationSeconds
  });
  if (error) throw wrapRpcError(error, 'ANALYSIS_RESERVE_FAILED');
  return normalizeRpcResult(data);
}

async function completeAnalysisOperation(client, { operationId, userId, result }) {
  const { data, error } = await client.rpc('complete_analysis_operation', {
    p_operation_id: operationId,
    p_user_id: userId,
    p_result: result
  });
  if (error) throw wrapRpcError(error, 'ANALYSIS_COMPLETE_FAILED');
  return normalizeRpcResult(data);
}

async function refundAnalysisOperation(client, { operationId, userId, reason }) {
  const { data, error } = await client.rpc('refund_analysis_operation', {
    p_operation_id: operationId,
    p_user_id: userId,
    p_reason: reason
  });
  if (error) throw wrapRpcError(error, 'ANALYSIS_REFUND_FAILED');
  return normalizeRpcResult(data);
}

async function sweepStaleAnalysisOperations(client, limit = 25) {
  const { data, error } = await client.rpc('refund_stale_analysis_operations', {
    p_limit: limit
  });
  if (error) throw wrapRpcError(error, 'ANALYSIS_SWEEP_FAILED');
  return normalizeRpcResult(data);
}

module.exports = {
  reserveAnalysisOperation,
  completeAnalysisOperation,
  refundAnalysisOperation,
  sweepStaleAnalysisOperations,
  normalizeRpcResult,
  wrapRpcError
};
