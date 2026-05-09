export const ensureTestEnvironment = (operation: string) => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `🚨 Attempted to run test operation "${operation}" outside of test environment!\n` +
        `This function can only be run in test environment.\n` +
        `Current environment: ${process.env.NODE_ENV}`
    )
  }

  // TODO: eventually we should name the database with a keyword like "test" and check if it's the right database
  // if (!process.env.DATABASE_URL?.includes('test')) {
  //   throw new Error(
  //     `🚨 Attempted to run test operation "${operation}" with non-test database!\n` +
  //       `This function can only be run with a test database.\n` +
  //       `Current DATABASE_URL: ${process.env.DATABASE_URL}`
  //   )
  // }
}
