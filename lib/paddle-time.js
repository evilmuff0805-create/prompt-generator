'use strict';

// Preserve Paddle's RFC3339 fractional-second precision. Converting through a
// JavaScript Date truncates microseconds to milliseconds and can collapse two
// distinct provider events before PostgreSQL compares them.
function parsePaddleTimestamp(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) {
    return null;
  }
  const normalized = value.trim();
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;

  if (
    year < 1
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || !Number.isFinite(Date.parse(normalized))
  ) {
    return null;
  }
  return normalized;
}

module.exports = {
  parsePaddleTimestamp
};
