export interface Line {
  item: string
  quantity: number
  unitCents: number
}

export function lineTotal(line: Line): number {
  return line.quantity * line.unitCents
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
