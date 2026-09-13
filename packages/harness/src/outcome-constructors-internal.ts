import { Data } from 'effect'
import type {
  OverflowCompactionResult as OverflowCompactionResultType,
  StepOutcome as StepOutcomeType
} from './outcome.ts'

export const OverflowCompactionResult = Data.taggedEnum<OverflowCompactionResultType>()

export const StepOutcome = Data.taggedEnum<StepOutcomeType>()
