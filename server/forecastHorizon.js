// Do not coerce arrays, objects or partial numbers from query strings.
export function forecastMonths(value) {
  if (value === undefined) return 3;
  return typeof value === 'string' && ['3', '6', '12'].includes(value) ? Number(value) : null;
}
