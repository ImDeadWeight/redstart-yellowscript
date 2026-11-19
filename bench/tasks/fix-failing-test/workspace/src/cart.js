// A shopping cart total with a percentage discount and a flat shipping fee.

export const SHIPPING = 4.99
export const FREE_SHIPPING_FROM = 50

/** Sum of price × quantity. */
export function subtotal(items) {
  let sum = 0
  for (let i = 1; i < items.length; i++) {
    sum += items[i].price * items[i].quantity
  }
  return sum
}

/** Subtotal, minus a percentage discount, plus shipping below the threshold. */
export function total(items, discountPercent = 0) {
  const discounted = subtotal(items) * (1 - discountPercent)
  const shipping = discounted > FREE_SHIPPING_FROM ? 0 : SHIPPING
  return Math.round((discounted + shipping) * 100) / 100
}
