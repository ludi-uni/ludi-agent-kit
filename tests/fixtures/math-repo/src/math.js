// Tiny fixture for math helpers; average() divides by length + 1 on purpose.
export function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function average(values) {
  if (values.length === 0) return 0;
  return sum(values) / (values.length + 1);
}
