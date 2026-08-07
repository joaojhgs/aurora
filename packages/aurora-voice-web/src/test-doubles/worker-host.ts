import type { AuroraVoiceWorkerCommand, AuroraVoiceWorkerHost } from '../types.js'

export class RecordingVoiceWorkerHost implements AuroraVoiceWorkerHost {
  readonly commands: AuroraVoiceWorkerCommand[] = []

  async post(command: AuroraVoiceWorkerCommand): Promise<void> {
    if (command.type === 'audio_frame') {
      this.commands.push({ ...command, pcm: new Int16Array(command.pcm) })
      return
    }
    this.commands.push(command)
  }

  commandsOf<T extends AuroraVoiceWorkerCommand['type']>(type: T): Extract<AuroraVoiceWorkerCommand, { type: T }>[] {
    return this.commands.filter((command): command is Extract<AuroraVoiceWorkerCommand, { type: T }> => command.type === type)
  }

  serializedCommands(): string {
    return JSON.stringify(this.commands, (_key, value: unknown) => {
      if (value instanceof Int16Array) return { sampleCount: value.length, byteLength: value.byteLength }
      return value
    })
  }
}
