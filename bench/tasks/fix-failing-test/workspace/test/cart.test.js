import { test } from 'node:test'
import assert from 'node:assert/strict'

import { subtotal, total } from '../src/cart.js'

const items = [
  { name: 'pencil', price: 2, quantity: 5 },
  { name: 'notebook', price: 6, quantity: 3 },
]

test('subtotal adds every line', () => {
  assert.equal(subtotal(items), 28)
})

test('a discount is a percentage', () => {
  assert.equal(total(items, 10), 30.19)
})

test('shipping is free from 50 exactly', () => {
  assert.equal(total([{ name: 'pen', price: 50, quantity: 1 }]), 50)
})
