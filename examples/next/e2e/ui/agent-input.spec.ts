import {
  AgentAwaitingInput,
  AgentEnd,
  AgentStart,
  InputCancelled,
  InputRequest,
  InputRequested,
  InputResponse,
  InputSubmitted,
  ToolCall,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import { test, expect } from '../fixtures'

const draft = {
  to: 'alex@example.com',
  subject: 'Friday project update',
  body: 'Hi Alex, the draft is ready for your review. Nothing has been sent.'
}

// Only the nondeterministic agent stream is stubbed. The page, auth fixture,
// client transport, event projection, and app-owned controls are real.
for (const scenario of ['submit', 'cancel', 'unsupported']) {
  test(`typed input ${scenario} encodes its response and renders server acceptance`, async ({
    authedPage
  }, testInfo) => {
    const unsupported = scenario === 'unsupported'
    const call = ToolCall.make({ id: `e2e_input_${scenario}`, name: 'compose_draft', params: {} })

    const request = InputRequest.make({
      requestId: `input:compose_draft:${call.id}`,
      toolCallId: call.id,
      call,
      input: {
        kind: unsupported ? 'unsupported-e2e' : 'draft-composer',
        title: unsupported ? 'Unsupported input' : 'Compose draft',
        description: 'Fill in the draft fields. Nothing is sent.'
      }
    })

    const response = InputResponse.make({
      requestId: request.requestId,
      toolCallId: call.id,
      outcome: scenario === 'submit' ? 'submitted' : 'cancelled',
      source: 'user',
      ...(scenario === 'submit'
        ? { data: draft }
        : {
            reason: unsupported
              ? 'No renderer for input kind "unsupported-e2e"'
              : 'Cancelled by user'
          })
    })

    let requestCount = 0
    let capturedBody = ''

    await authedPage.route('**/api/agent', async route => {
      requestCount += 1

      const events =
        requestCount === 1
          ? [
              AgentStart.make({}),
              InputRequested.make({ request }),
              AgentAwaitingInput.make({
                requests: [request],
                messages: [],
                turns: 1,
                usage: zeroAgentUsage
              })
            ]
          : [
              AgentStart.make({}),
              scenario === 'submit'
                ? InputSubmitted.make({ response })
                : InputCancelled.make({ response }),
              AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })
            ]

      if (requestCount > 1) {
        capturedBody = route.request().postData() ?? ''
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: `${events.map(event => JSON.stringify(event)).join('\n')}\n`
      })
    })

    await authedPage.setViewportSize(
      scenario === 'cancel' ? { width: 390, height: 844 } : { width: 1280, height: 900 }
    )
    await authedPage.goto('/agent/next')
    const prompt = authedPage.getByLabel('Agent prompt')
    await expect(prompt).toHaveCount(1, { timeout: 30_000 })
    await prompt.fill('Help me compose a draft. Do not send it.')
    await authedPage.getByRole('button', { name: 'Send', exact: true }).click()

    const controls = authedPage.getByRole('group', {
      name: unsupported ? 'Unsupported input' : 'Compose draft',
      exact: true
    })

    await expect(controls).toBeVisible()
    await expect(authedPage.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()

    if (unsupported) {
      await expect(controls.getByText(/is not supported here/)).toBeVisible()
      await expect(controls.getByRole('textbox')).toHaveCount(0)
    } else {
      await expect(authedPage.getByRole('button', { name: 'Submit draft' })).toBeDisabled()
      await controls.getByLabel('To', { exact: true }).fill(draft.to)
      await controls.getByLabel('Subject', { exact: true }).fill(draft.subject)
      await controls.getByLabel('Body', { exact: true }).fill(draft.body)
      await expect(authedPage.getByRole('button', { name: 'Submit draft' })).toBeEnabled()
    }

    await authedPage.screenshot({ path: testInfo.outputPath(`input-${scenario}.png`) })
    await authedPage
      .getByRole('button', { name: scenario === 'submit' ? 'Submit draft' : 'Cancel', exact: true })
      .click()
    await expect.poll(() => capturedBody).not.toBe('')
    const parsedBody: unknown = JSON.parse(capturedBody)
    expect(parsedBody).toMatchObject({ hitlResponses: [JSON.parse(JSON.stringify(response))] })
    await expect(controls).toHaveCount(0)
    await expect(authedPage.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    expect(requestCount).toBe(2)
  })
}
