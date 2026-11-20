/**
 * Property runs: `PROPERTY_RUNS` when it is a positive integer, else `defaultRuns` (the agent
 * package's convention; stress a property with a large `PROPERTY_RUNS`).
 */
export const propertyOptionsWith = (defaultRuns: number) => {
  const parsed = Number(process.env.PROPERTY_RUNS ?? defaultRuns)

  return { arbitrary: { runs: Number.isInteger(parsed) && parsed > 0 ? parsed : defaultRuns } }
}
