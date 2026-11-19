// =============================================================================
// In-chat approvals: the queue of tool calls waiting for allow / deny.
// =============================================================================
// Commands, file writes and Nest's own tools used to ask through VS Code's
// modal dialogs. They now ask on a card in the chat, the way the chat app
// does. Each gate (ui/run-command.ts, ui/write-approval.ts,
// ui/nest-approval.ts) builds an ApprovalRequest and awaits `ask`; the
// person's click resolves it with one of the request's option ids.
//
// One card at a time. Tool calls in one reply can run in parallel, so a
// second request waits behind the first instead of replacing it — denying
// something the person never saw would be as wrong as running it.
//
// Never rejects. An abort (Stop, a closed tab) resolves every waiting request
// with its deny option: nothing runs that nobody allowed.
//
// No `vscode` import.
// =============================================================================

import type { ApprovalFileView, ApprovalOptionView, ApprovalView } from './protocol.ts'

export interface ApprovalRequest {
  kind: ApprovalView['kind']
  title: string
  subject: string
  detail?: string
  files?: ApprovalFileView[]
  /** Must include one option of kind 'deny'. */
  options: ApprovalOptionView[]
  /** Open file `index`'s diff in the editor (a write approval). */
  openFile?: (index: number) => void
}

/** What a gate calls: resolves with the chosen option id. */
export type AskApproval = (request: ApprovalRequest) => Promise<string>

interface Waiting {
  id: string
  request: ApprovalRequest
  resolve: (choice: string) => void
}

/** The option id that means "no" for a request. */
export function denyOption(request: ApprovalRequest): string {
  return request.options.find((o) => o.kind === 'deny')?.id ?? 'deny'
}

export class ApprovalQueue {
  private readonly waiting: Waiting[] = []
  private readonly onChange: () => void
  private readonly newId: () => string

  constructor(onChange: () => void, newId: () => string) {
    this.onChange = onChange
    this.newId = newId
  }

  /** Ask; resolves with an option id, or the deny option on abort. */
  ask(request: ApprovalRequest, signal?: AbortSignal): Promise<string> {
    const deny = denyOption(request)
    if (signal?.aborted) return Promise.resolve(deny)
    const id = this.newId()
    return new Promise((resolve) => {
      const onAbort = () => this.decide(id, deny)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push({
        id,
        request,
        resolve: (choice) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(choice)
        },
      })
      this.onChange()
    })
  }

  /**
   * Decide request `id`. An unknown id (a late click) or a choice the request
   * did not offer does nothing, and returns false.
   */
  decide(id: string, choice: string): boolean {
    const index = this.waiting.findIndex((w) => w.id === id)
    if (index < 0) return false
    const waiting = this.waiting[index]!
    if (!waiting.request.options.some((o) => o.id === choice)) return false
    this.waiting.splice(index, 1)
    waiting.resolve(choice)
    this.onChange()
    return true
  }

  /** Deny everything waiting. */
  denyAll(): void {
    for (const waiting of [...this.waiting]) this.decide(waiting.id, denyOption(waiting.request))
  }

  /** Open a file of the request on screen. */
  openFile(id: string, index: number): void {
    const head = this.waiting[0]
    if (head?.id === id) head.request.openFile?.(index)
  }

  /** The card to show: the first request, with how many wait behind it. */
  view(): ApprovalView | null {
    const head = this.waiting[0]
    if (!head) return null
    const { request } = head
    return {
      id: head.id,
      kind: request.kind,
      title: request.title,
      subject: request.subject,
      ...(request.detail ? { detail: request.detail } : {}),
      ...(request.files ? { files: request.files.map((f) => ({ ...f })) } : {}),
      options: request.options.map((o) => ({ ...o })),
      queued: this.waiting.length - 1,
    }
  }
}
