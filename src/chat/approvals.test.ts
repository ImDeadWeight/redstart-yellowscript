// Tests for the in-chat approval queue.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalQueue, type ApprovalRequest } from './approvals.ts'

const request = (subject: string): ApprovalRequest => ({
  kind: 'command',
  title: 'Run a command',
  subject,
  options: [
    { id: 'run', label: 'Run', kind: 'allow' },
    { id: 'always', label: 'Always allow', kind: 'always' },
    { id: 'deny', label: 'Deny', kind: 'deny' },
  ],
})

function makeQueue() {
  let n = 0
  let changes = 0
  const queue = new ApprovalQueue(() => changes++, () => `a${++n}`)
  return { queue, changes: () => changes }
}

describe('ApprovalQueue', () => {
  it('shows a request and resolves with the chosen option', async () => {
    const { queue, changes } = makeQueue()
    const pending = queue.ask(request('npm test'))
    const view = queue.view()
    assert.equal(view?.subject, 'npm test')
    assert.equal(view?.queued, 0)
    assert.equal(queue.decide(view!.id, 'always'), true)
    assert.equal(await pending, 'always')
    assert.equal(queue.view(), null)
    assert.equal(changes(), 2)
  })

  it('queues a second request behind the first instead of replacing it', async () => {
    const { queue } = makeQueue()
    const first = queue.ask(request('npm test'))
    const second = queue.ask(request('npm run build'))
    const head = queue.view()!
    assert.equal(head.subject, 'npm test')
    assert.equal(head.queued, 1)
    queue.decide(head.id, 'run')
    assert.equal(await first, 'run')
    assert.equal(queue.view()?.subject, 'npm run build')
    queue.decide(queue.view()!.id, 'deny')
    assert.equal(await second, 'deny')
  })

  it('ignores a stale id and a choice the request did not offer', () => {
    const { queue } = makeQueue()
    void queue.ask(request('npm test'))
    const id = queue.view()!.id
    assert.equal(queue.decide('nope', 'run'), false)
    assert.equal(queue.decide(id, 'sudo'), false)
    assert.equal(queue.view()?.id, id)
  })

  it('denies on abort, and at once when already aborted', async () => {
    const { queue } = makeQueue()
    const controller = new AbortController()
    const pending = queue.ask(request('npm test'), controller.signal)
    controller.abort()
    assert.equal(await pending, 'deny')
    assert.equal(queue.view(), null)
    assert.equal(await queue.ask(request('x'), controller.signal), 'deny')
  })

  it('denyAll denies everything waiting', async () => {
    const { queue } = makeQueue()
    const a = queue.ask(request('a'))
    const b = queue.ask(request('b'))
    queue.denyAll()
    assert.deepEqual(await Promise.all([a, b]), ['deny', 'deny'])
  })

  it('opens a file only for the request on screen', () => {
    const { queue } = makeQueue()
    const opened: number[] = []
    void queue.ask({ ...request('write'), kind: 'write', openFile: (i) => opened.push(i) })
    queue.openFile('stale', 0)
    queue.openFile(queue.view()!.id, 2)
    assert.deepEqual(opened, [2])
  })
})
