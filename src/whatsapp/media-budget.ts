// Persistent account-wide budget. Reserve before network I/O, including failures.
// Disabled media never creates this table. This is not per caller or per message.
interface BudgetStorage {
  sql: {
    exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>
  }
  transactionSync<T>(callback: () => T): T
}
const WINDOW_MS = 60 * 60 * 1000
const MIN_INTERVAL_MS = 10_000
const MAX_ATTEMPTS = 30

export function reserveMediaAttempt(storage: BudgetStorage, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("MEDIA_BUDGET_UNAVAILABLE")
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS media_read_budget (id INTEGER PRIMARY KEY CHECK (id = 1), started INTEGER NOT NULL, last INTEGER NOT NULL, attempts INTEGER NOT NULL)",
    )
    const previous = Array.from(
      storage.sql.exec("SELECT started, last, attempts FROM media_read_budget WHERE id = 1"),
    )[0]
    let started = now
    let attempts = 0
    if (previous) {
      const { started: oldStart, last, attempts: oldAttempts } = previous
      if (
        typeof oldStart !== "number" ||
        !Number.isSafeInteger(oldStart) ||
        oldStart < 0 ||
        typeof last !== "number" ||
        !Number.isSafeInteger(last) ||
        last < oldStart ||
        typeof oldAttempts !== "number" ||
        !Number.isSafeInteger(oldAttempts) ||
        oldAttempts < 1 ||
        oldAttempts > MAX_ATTEMPTS
      )
        throw new Error("MEDIA_BUDGET_UNAVAILABLE")
      if (now < last || now - last < MIN_INTERVAL_MS) throw new Error("MEDIA_RATE_LIMITED")
      if (now - oldStart < WINDOW_MS) {
        started = oldStart
        attempts = oldAttempts
      }
    }
    if (attempts >= MAX_ATTEMPTS) throw new Error("MEDIA_RATE_LIMITED")
    storage.sql.exec(
      "INSERT INTO media_read_budget (id, started, last, attempts) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET started = excluded.started, last = excluded.last, attempts = excluded.attempts",
      started,
      now,
      attempts + 1,
    )
  })
}
