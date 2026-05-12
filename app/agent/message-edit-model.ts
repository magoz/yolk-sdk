type EditKeyInput = {
  readonly key: string
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}

export const editDraftText = (value: string) => value.trim()

export const canSaveEditedMessage = ({
  currentText,
  draftText,
  disabled
}: {
  readonly currentText: string
  readonly draftText: string
  readonly disabled: boolean
}) => !disabled && editDraftText(draftText).length > 0 && editDraftText(draftText) !== currentText.trim()

export const editKeyAction = (event: EditKeyInput) => {
  if (event.key === 'Escape') {
    return 'cancel'
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    return event.metaKey || event.ctrlKey ? 'save' : 'save'
  }

  return 'none'
}
