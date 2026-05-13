import {
  ensurePublicUrlWithoutDns,
  makeWebFetchToolModule,
  requestWithHttpClient,
  type WebFetchToolDependencies
} from './web-fetch-tool.ts'

export const workerWebFetchToolDependencies: WebFetchToolDependencies = {
  ensurePublicUrl: ensurePublicUrlWithoutDns,
  request: requestWithHttpClient
}

export const webFetchWorkerToolModule = makeWebFetchToolModule(workerWebFetchToolDependencies)
