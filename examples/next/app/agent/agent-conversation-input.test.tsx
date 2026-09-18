// @vitest-environment jsdom
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  InputDescriptor,
  InputRequest,
  QuestionRequest,
  ToolCall,
  type InputResponse,
  type QuestionResponse,
  type ToolApprovalResponse
} from '@yolk-sdk/agent/protocol'
import type { AgentChatItem } from '@yolk-sdk/agent/react'
import { AgentConversation } from './agent-conversation.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => undefined
}

const noop = () => undefined

const draftCall = ToolCall.make({ id: 'call_draft', name: 'compose_draft', params: {} })

const draftRequest = InputRequest.make({
  requestId: 'input:compose_draft:call_draft',
  toolCallId: draftCall.id,
  call: draftCall,
  input: InputDescriptor.make({
    kind: 'draft-composer',
    title: 'Compose draft',
    description: 'Fill in the draft fields. Nothing is sent.'
  })
})

const draftItem: AgentChatItem = {
  _tag: 'ToolRun',
  id: 'tool-1',
  messageId: 'msg-1',
  call: draftCall,
  state: { _tag: 'InputRequested', request: draftRequest, duration: { _tag: 'Unknown' } }
}

const renderConversation = (
  container: HTMLElement,
  items: ReadonlyArray<AgentChatItem>,
  handlers: {
    readonly onInputResponse?: (response: InputResponse) => void
    readonly onQuestionResponse?: (response: QuestionResponse) => void
  } = {}
) => {
  const root = createRoot(container)

  act(() => {
    root.render(
      createElement(AgentConversation, {
        items,
        showInlineTools: true,
        showReasoning: true,
        actionsDisabled: false,
        hitlDisabled: false,
        onDeleteTurn: noop,
        onEditUserMessage: noop,
        onRegenerateFrom: noop,
        onToolApprovalResponse: (_response: ToolApprovalResponse) => undefined,
        onQuestionResponse: handlers.onQuestionResponse ?? noop,
        onInputResponse: handlers.onInputResponse ?? noop
      })
    )
  })

  return root
}

const setFieldValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype

  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set

  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const clickButton = (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll('button')].find(
    candidate => candidate.textContent?.trim() === label
  )

  if (button === undefined) {
    throw new Error(`Button not found: ${label}`)
  }

  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('AgentConversation input controls', () => {
  it('submits the draft composer fields as an InputResponse', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onInputResponse = vi.fn()

    try {
      const root = renderConversation(container, [draftItem], { onInputResponse })

      expect(container.textContent).toContain('Compose draft')

      const to = container.querySelector<HTMLInputElement>('input[id$="-to"]')
      const subject = container.querySelector<HTMLInputElement>('input[id$="-subject"]')
      const body = container.querySelector<HTMLTextAreaElement>('textarea[id$="-body"]')

      expect(to).not.toBeNull()
      expect(subject).not.toBeNull()
      expect(body).not.toBeNull()

      // Submit stays disabled until all accessible fields are filled.
      const submit = [...container.querySelectorAll('button')].find(
        candidate => candidate.textContent?.trim() === 'Submit draft'
      )

      expect(submit?.disabled).toBe(true)

      if (to === null || subject === null || body === null) {
        expect.fail('Expected draft composer fields')
      }

      setFieldValue(to, 'a@example.com')
      setFieldValue(subject, 'Hello')
      setFieldValue(body, 'Draft body.')
      expect(submit?.disabled).toBe(false)

      clickButton(container, 'Submit draft')

      expect(onInputResponse).toHaveBeenCalledTimes(1)

      const response = onInputResponse.mock.calls[0]?.[0]
      expect(response?.outcome).toBe('submitted')
      expect(response?.requestId).toBe('input:compose_draft:call_draft')
      expect(response?.toolCallId).toBe('call_draft')
      expect(response?.data).toEqual({
        to: 'a@example.com',
        subject: 'Hello',
        body: 'Draft body.'
      })

      act(() => {
        root.unmount()
      })
    } finally {
      container.remove()
    }
  })

  it('cancels the draft composer', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onInputResponse = vi.fn()

    try {
      const root = renderConversation(container, [draftItem], { onInputResponse })
      clickButton(container, 'Cancel')

      expect(onInputResponse).toHaveBeenCalledTimes(1)
      expect(onInputResponse.mock.calls[0]?.[0]?.outcome).toBe('cancelled')
      expect(onInputResponse.mock.calls[0]?.[0]?.requestId).toBe('input:compose_draft:call_draft')

      act(() => {
        root.unmount()
      })
    } finally {
      container.remove()
    }
  })

  it('falls back with cancel for unknown renderer kinds', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onInputResponse = vi.fn()
    const mysteryCall = ToolCall.make({ id: 'call_x', name: 'mystery_tool', params: {} })

    const mysteryItem: AgentChatItem = {
      _tag: 'ToolRun',
      id: 'tool-x',
      messageId: 'msg-x',
      call: mysteryCall,
      state: {
        _tag: 'InputRequested',
        request: InputRequest.make({
          requestId: 'input:mystery_tool:call_x',
          toolCallId: mysteryCall.id,
          call: mysteryCall,
          input: InputDescriptor.make({ kind: 'mystery-kind' })
        }),
        duration: { _tag: 'Unknown' }
      }
    }

    try {
      const root = renderConversation(container, [mysteryItem], { onInputResponse })

      expect(container.textContent).toContain('mystery-kind')
      expect(container.querySelector('input')).toBeNull()

      clickButton(container, 'Cancel')

      expect(onInputResponse).toHaveBeenCalledTimes(1)
      const response = onInputResponse.mock.calls[0]?.[0]
      expect(response?.outcome).toBe('cancelled')
      expect(response?.requestId).toBe('input:mystery_tool:call_x')

      act(() => {
        root.unmount()
      })
    } finally {
      container.remove()
    }
  })

  it('keeps question controls working (regression)', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onQuestionResponse = vi.fn()
    const questionCall = ToolCall.make({ id: 'call_q', name: 'question', params: {} })

    const questionItem: AgentChatItem = {
      _tag: 'ToolRun',
      id: 'tool-q',
      messageId: 'msg-q',
      call: questionCall,
      state: {
        _tag: 'QuestionRequested',
        request: QuestionRequest.make({
          requestId: 'question:call_q',
          toolCallId: questionCall.id,
          call: questionCall,
          questions: [{ id: 'q1', prompt: 'Pick one?' }]
        }),
        duration: { _tag: 'Unknown' }
      }
    }

    try {
      const root = renderConversation(container, [questionItem], { onQuestionResponse })

      expect(container.textContent).toContain('Pick one?')

      clickButton(container, 'Cancel')

      expect(onQuestionResponse).toHaveBeenCalledTimes(1)
      expect(onQuestionResponse.mock.calls[0]?.[0]?.outcome).toBe('cancelled')

      act(() => {
        root.unmount()
      })
    } finally {
      container.remove()
    }
  })
})
