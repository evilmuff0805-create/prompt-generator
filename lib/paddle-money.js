'use strict';

// Credit-pack amount evidence is passed to PostgreSQL RPC parameters declared
// as `integer`, so the JavaScript boundary must match PostgreSQL int4 rather
// than merely Number.MAX_SAFE_INTEGER.
const MAX_POSTGRES_INTEGER = 2147483647;

function parsePostgresMinorUnitAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const amount = Number(value);
  return Number.isSafeInteger(amount)
    && amount >= 0
    && amount <= MAX_POSTGRES_INTEGER
    ? amount
    : null;
}

function isPostgresMinorUnitAmount(value) {
  return parsePostgresMinorUnitAmount(value) !== null;
}

module.exports = {
  MAX_POSTGRES_INTEGER,
  isPostgresMinorUnitAmount,
  parsePostgresMinorUnitAmount
};
