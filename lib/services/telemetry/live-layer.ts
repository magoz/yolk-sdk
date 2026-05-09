import { NodeSdk } from '@effect/opentelemetry'
import { SentrySpanProcessor } from '@sentry/opentelemetry'
import { BatchLogRecordProcessor, ConsoleLogRecordExporter } from '@opentelemetry/sdk-logs'

// Note: Uses process.env because NodeSdk.layer() requires a synchronous callback
// This is an acceptable exception for infrastructure-level code
export const TelemetryLayer = NodeSdk.layer(() => {
  const serviceName = process.env.APP_NAME
  if (!serviceName) throw new Error('APP_NAME not found')

  const environment = process.env.NODE_ENV || 'development'
  const serviceVersion = process.env.npm_package_version || '1.0.0'

  return {
    resource: {
      serviceName,
      serviceVersion,
      attributes: {
        'deployment.environment': environment
      }
    },

    // Sentry receives all spans via OpenTelemetry bridge
    spanProcessor: new SentrySpanProcessor(),

    // Logs go to console (Sentry captures as breadcrumbs)
    logRecordProcessor: new BatchLogRecordProcessor(new ConsoleLogRecordExporter()),

    // Shutdown timeout for serverless
    shutdownTimeout: '5 seconds'
  }
})
