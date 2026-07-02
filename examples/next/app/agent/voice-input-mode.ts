export type VoiceInputMode = 'realtime' | 'hold'

export type VoiceInputModeOption = {
  readonly mode: VoiceInputMode
  readonly label: string
  readonly description: string
}

export const voiceInputModeOptions: ReadonlyArray<VoiceInputModeOption> = [
  {
    mode: 'realtime',
    label: 'realtime',
    description: 'Fluid speech-to-speech conversation over OpenAI Realtime.'
  },
  {
    mode: 'hold',
    label: 'hold to speak',
    description:
      'Hold the mic to record, release to transcribe. The agent answers through the full text runtime and replies with speech.'
  }
]
