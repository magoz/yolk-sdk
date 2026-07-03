const defaultPropertyRuns = 50

const propertyRunsEnv = process.env.PROPERTY_RUNS
const parsedPropertyRuns =
  propertyRunsEnv === undefined ? defaultPropertyRuns : Number(propertyRunsEnv)

export const propertyRuns =
  Number.isInteger(parsedPropertyRuns) && parsedPropertyRuns > 0
    ? parsedPropertyRuns
    : defaultPropertyRuns

export const propertyOptions = { fastCheck: { numRuns: propertyRuns } }
