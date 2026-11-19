import { readFileSync } from 'node:fs'

export function loadScores(url) {
  return JSON.parse(readFileSync(url, 'utf8')).scores
}
