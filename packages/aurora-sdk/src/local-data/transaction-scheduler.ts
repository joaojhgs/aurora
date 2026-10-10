import type { LocalDataRepositories } from './repositories.js'
import type { LocalDataSession } from './session.js'

type TransactionTail = Promise<void>

const transactionTails = new WeakMap<LocalDataSession, TransactionTail>()

/**
 * Serializes top-level transaction entry for one local-data session.
 *
 * The callback receives only transaction-scoped repositories. It must not
 * capture the session or scheduler and start another transaction from inside
 * the callback; nested transaction boundaries remain an adapter error.
 */
export async function runSerializedLocalDataTransaction<T>(
  session: LocalDataSession,
  work: (repositories: LocalDataRepositories) => Promise<T>
): Promise<T> {
  const previous = transactionTails.get(session) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  transactionTails.set(session, tail)

  await previous
  try {
    return await session.transaction(work)
  } finally {
    release()
    if (transactionTails.get(session) === tail) transactionTails.delete(session)
  }
}
