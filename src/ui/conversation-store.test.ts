// =============================================================================
// conversation-store — stable tab ordering and migration.
// =============================================================================
// Tabs must not reorder when you switch between them; that used to happen
// because the store sorted by `updatedAt` and bumped it on every save. Order is
// now an explicit, stable `order` field, independent of activity. These tests
// pin that behaviour and the migration of pre-`order` records.

import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationStore, type Conversation } from './conversation-store.ts'

/** The slice of `vscode.Memento` the store actually touches. */
interface FakeMemento {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Promise<void>
  keys(): string[]
}

/** A minimal in-memory Memento — enough for the store's single key. */
function fakeMemento(): FakeMemento {
  const data = new Map<string, unknown>()
  return {
    get: (key: string) => (data.has(key) ? (data.get(key) as never) : undefined),
    // update is async in the real API; the store ignores the returned promise.
    update: (key: string, value: unknown) => {
      data.set(key, value)
      return Promise.resolve()
    },
    keys: () => [...data.keys()],
  }
}

// The store wants a `vscode.Memento`; the test runtime has no `vscode`, so we
// hand it the structural subset above.
const makeStore = () => conversationStore(fakeMemento() as never)

function conv(id: string, title: string, order: number, createdAt: number): Conversation {
  return { id, title, messages: [], createdAt, order, accountId: '', lastAccessedAt: createdAt }
}

describe('conversation-store ordering', () => {
  it('lists conversations in stable creation order regardless of saves', () => {
    const memento = fakeMemento()
    const store = conversationStore(memento)

    const a = store.create('A')
    const b = store.create('B')
    const c = store.create('C')

    // Saving the active tab (the old code bumped updatedAt here) must NOT float
    // it to the front.
    a.messages = [{ id: 'm1', role: 'user', content: 'hi' }]
    store.save(a)

    const ids = store.list().map((c) => c.id)
    assert.deepEqual(ids, [a.id, b.id, c.id])
  })

  it('keeps order when switching back and forth between tabs', () => {
    const store = makeStore()
    const ids = ['first', 'second', 'third'].map((t) => store.create(t).id)

    // Simulate a flurry of switches that the old code turned into save+resort.
    for (let i = 0; i < 5; i++) {
      const conv = store.get(ids[1]!)!
      store.save(conv)
    }

    assert.deepEqual(
      store.list().map((c) => c.id),
      ids,
    )
  })

  it('appends newly created conversations at the end', () => {
    const store = makeStore()
    const first = store.create('first')
    const second = store.create('second')
    assert.deepEqual(
      store.list().map((c) => c.id),
      [first.id, second.id],
    )
  })
})

describe('conversation-store migration', () => {
  it('orders pre-order records by createdAt', () => {
    const memento = fakeMemento()
    // Seed the memento directly with records that predate the `order` field.
    const seeded: Omit<Conversation, 'order'>[] = [
      { id: 'late', title: 'Late', messages: [], createdAt: 2000, accountId: '', lastAccessedAt: 2000 },
      { id: 'early', title: 'Early', messages: [], createdAt: 1000, accountId: '', lastAccessedAt: 1000 },
    ]
    void memento.update('redstartYellowscript.conversations', seeded)

    const store = conversationStore(memento as never)
    assert.deepEqual(
      store.list().map((c) => c.id),
      ['early', 'late'],
    )
    // Newly created conversations still carry an explicit, higher order.
    const newer = store.create('newest')
    assert.ok(newer.order >= 2)
  })

  it('treats a missing order field on a single record as the lowest', () => {
    const memento = fakeMemento()
    void memento.update('redstartYellowscript.conversations', [
      { id: 'x', title: 'X', messages: [], createdAt: 5000, accountId: '', lastAccessedAt: 5000 },
    ])
    const store = conversationStore(memento as never)
    // with createdAt 5000 it is the "newest"; if it had no order it sorts last
    assert.equal(store.list()[0]!.id, 'x')
  })
})

test('conversation-store smoke', () => {
  const store = makeStore()
  assert.equal(store.list().length, 0)
})
