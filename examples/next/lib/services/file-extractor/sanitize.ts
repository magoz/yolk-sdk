const nonPrintableCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const longDotRuns = /\.{4,}/g
const horizontalWhitespaceRuns = /[\t ]{2,}/g
const blankLineRuns = /\n{3,}/g

export const sanitizeExtractedText = (text: string) =>
  text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(nonPrintableCharacters, '')
    .replace(longDotRuns, '…')
    .replace(horizontalWhitespaceRuns, ' ')
    .replace(blankLineRuns, '\n\n')
    .trim()
