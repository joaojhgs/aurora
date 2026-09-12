export const BROWSER_SQLITE_MAX_REQUEST_BYTES = 2 * 1024 * 1024

// Local-data exports are semantically bounded to 16 MiB before their worker
// request envelope is serialized. Keep enough bounded headroom for JSON
// framing while limiting the exemption to the atomic import command.
export const BROWSER_SQLITE_MAX_IMPORT_REQUEST_BYTES = 32 * 1024 * 1024

export function browserSqliteRequestByteLimit(command: unknown): number {
  return command === 'importV1'
    ? BROWSER_SQLITE_MAX_IMPORT_REQUEST_BYTES
    : BROWSER_SQLITE_MAX_REQUEST_BYTES
}
