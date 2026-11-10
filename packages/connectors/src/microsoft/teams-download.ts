import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  SafeText,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  fileBytes,
  readBytes,
  safeToken,
  validateTransfer
} from '../transfer-internal.ts'
import { MicrosoftTeamsTranscriptReadOAuthCredentialSlot } from './oauth.ts'
import { microsoftGraphApiBaseUrl, resolveMicrosoftAccessToken } from './shared.ts'
import { TeamsMeetingId } from './teams.ts'

export interface TeamsDownloadTranscriptInput {
  readonly meetingId: string
  readonly transcriptId: string
}

const Input = Schema.Struct({ meetingId: TeamsMeetingId, transcriptId: TeamsMeetingId })

const OptionalText = Schema.optional(Schema.NullOr(SafeText))

const Metadata = Schema.Struct({
  id: SafeText,
  meetingId: OptionalText,
  createdDateTime: OptionalText,
  endDateTime: OptionalText
})

/** The transcript format the download asks Graph for (WebVTT with speaker names). */
export const teamsTranscriptMimeType = 'text/vtt'

/**
 * Host-only: downloads one Teams meeting transcript as WebVTT bytes under the opt-in
 * `OnlineMeetingTranscript.Read.All` slot. It reads the transcript's metadata first (its id must
 * match), then `content?$format=text/vtt`, through the binary port without following redirects.
 * Failures are typed transfer codes only: never bodies, URLs or headers. A tenant that turned off
 * Graph access to transcripts answers 403 (`forbidden`).
 */
export const downloadTeamsMeetingTranscript = (
  integration: ConnectorIntegration,
  input: TeamsDownloadTranscriptInput,
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'microsoft', budget)
    const target = yield* decodeInput(Input, input)

    const token = yield* resolveMicrosoftAccessToken(
      integration,
      MicrosoftTeamsTranscriptReadOAuthCredentialSlot
    ).pipe(Effect.mapError(credentialFailure), Effect.flatMap(safeToken))

    const url = `${microsoftGraphApiBaseUrl}/me/onlineMeetings/${encodeURIComponent(target.meetingId)}/transcripts/${encodeURIComponent(target.transcriptId)}`

    const metadataResponse = yield* readBytes(
      url,
      { authorization: `Bearer ${token}`, accept: 'application/json' },
      limits,
      true
    )

    const metadata = yield* decodeMetadata(Metadata, metadataResponse.bytes)

    if (metadata.id !== target.transcriptId) return yield* failTransfer('invalid_metadata')

    const content = yield* readBytes(
      `${url}/content?$format=${teamsTranscriptMimeType}`,
      { authorization: `Bearer ${token}`, accept: teamsTranscriptMimeType },
      limits
    )

    return {
      ...fileBytes(content.bytes),
      mimeType: teamsTranscriptMimeType,
      source: {
        meetingId: target.meetingId,
        transcriptId: metadata.id,
        createdDateTime: metadata.createdDateTime ?? undefined,
        endDateTime: metadata.endDateTime ?? undefined
      }
    }
  })
