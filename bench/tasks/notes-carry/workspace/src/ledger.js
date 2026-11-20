export function balance(entries) {
  return entries.reduce((sum, e) => sum + (e.kind === 'credit' ? e.amount : -e.amount), 0)
}

export function byMonth(entries) {
  const out = {}
  for (const e of entries) (out[e.date.slice(0, 7)] ??= []).push(e)
  return out
}
