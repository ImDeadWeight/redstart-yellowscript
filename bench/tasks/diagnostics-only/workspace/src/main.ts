import { formatCents, lineTotal, type Line } from './invoice.ts'

const lines: Line[] = [
  { item: 'Widget', quantity: 3, unitCents: 250 },
  { item: 'Gadget', quantity: '2', unitCents: 1000 },
  { item: 'Gizmo', quantity: 1, unitCents: '499' },
]

let total = 0
for (const line of lines) {
  total += lineTotal(line)
  console.log(`${line.item}: ${formatCents(lineTotal(line))}`)
}
console.log(`Total: ${formatCents(total)}`)
