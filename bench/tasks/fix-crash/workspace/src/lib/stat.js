/** Count, total, and the best entry of a score list. */
export function summarise(scores) {
  let best = scores[0]
  let total = 0
  for (const s of scores) {
    total += s.points
    if (s.points > best.points) best = s
  }
  return { count: scores.length, total, best }
}
