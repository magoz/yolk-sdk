'use client'

/**
 * Tiny generated earcons for realtime voice state. The realtime session has a
 * connecting window where speech is not captured yet; the ready chime tells
 * the user exactly when the mic is hot without them watching the icon.
 *
 * Web Audio contexts must be created/resumed inside a user gesture in some
 * browsers, but the live transition happens async after connect. Hosts call
 * `primeVoiceEarcon()` from the toggle click handler and
 * `playVoiceReadyEarcon()` on the live rising edge.
 */

let audioContext: AudioContext | null = null

const getAudioContext = () => {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    return null
  }

  if (audioContext === null) {
    audioContext = new AudioContext()
  }

  return audioContext
}

/** Create/resume the shared context inside a user gesture. Safe no-op elsewhere. */
export const primeVoiceEarcon = () => {
  const context = getAudioContext()

  if (context !== null && context.state === 'suspended') {
    void context.resume().catch(() => undefined)
  }
}

const playTone = (
  context: AudioContext,
  frequency: number,
  startAtSeconds: number,
  durationSeconds: number
) => {
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const startTime = context.currentTime + startAtSeconds
  const endTime = startTime + durationSeconds

  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0, startTime)
  gain.gain.linearRampToValueAtTime(0.08, startTime + 0.015)
  gain.gain.linearRampToValueAtTime(0, endTime)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(startTime)
  oscillator.stop(endTime)
}

/** Two-note rising chime: "realtime is live, the mic is capturing now". */
export const playVoiceReadyEarcon = () => {
  const context = getAudioContext()

  if (context === null) {
    return
  }

  if (context.state === 'suspended') {
    void context.resume().catch(() => undefined)
  }

  playTone(context, 660, 0, 0.11)
  playTone(context, 880, 0.09, 0.14)
}
