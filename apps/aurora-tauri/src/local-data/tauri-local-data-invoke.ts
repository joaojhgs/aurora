import { invoke } from '@tauri-apps/api/core'

const allowedAuroraLocalDataCommands = new Set([
  'aurora_local_data_open',
  'aurora_local_data_status',
  'aurora_local_data_close',
  'aurora_local_data_transaction_begin',
  'aurora_local_data_transaction_commit',
  'aurora_local_data_transaction_rollback',
  'aurora_local_data_repository_operation',
  'aurora_local_data_export_v1',
  'aurora_local_data_import_v1',
  'aurora_local_data_envelope_encrypt',
  'aurora_local_data_envelope_decrypt',
  'aurora_local_data_envelope_rotate'
])

export async function invokeAuroraLocalDataCommand(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!allowedAuroraLocalDataCommands.has(command)) throw new Error(`Unsupported Aurora local data command: ${command}`)
  return await invoke(command, args)
}
