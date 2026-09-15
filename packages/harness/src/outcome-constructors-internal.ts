import { Data } from 'effect'
import type { StopReceipt as StopReceiptType } from './coordinator.ts'
import type { StopDecision as StopDecisionType } from './driver.ts'
import type {
  HitlMatch as HitlMatchType,
  OverflowCompactionResult as OverflowCompactionResultType,
  StepOutcome as StepOutcomeType
} from './outcome.ts'

export const OverflowCompactionResult = Data.taggedEnum<OverflowCompactionResultType>()

export const StepOutcome = Data.taggedEnum<StepOutcomeType>()

export const HitlMatch = Data.taggedEnum<HitlMatchType>()

export const StopReceipt = Data.taggedEnum<StopReceiptType>()

export const StopDecision = Data.taggedEnum<StopDecisionType>()
