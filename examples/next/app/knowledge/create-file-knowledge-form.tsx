'use client'

import { useRef, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createFileKnowledgeRecordAction } from '@/lib/core/knowledge/create-file-knowledge-record-action'

const acceptedFileTypes =
  '.txt,.md,.markdown,.csv,.json,.pdf,.docx,.xlsx,.pptx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation'

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const fileKey = (file: File) => `${file.name}-${file.size}-${file.lastModified}`

export function CreateFileKnowledgeForm() {
  const [message, setMessage] = useState<string | undefined>()
  const [selectedFiles, setSelectedFiles] = useState<ReadonlyArray<File>>([])
  const [isDragging, setIsDragging] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [isPending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = (files: FileList) => {
    const incoming = Array.from(files)
    setSelectedFiles(current => {
      const existing = new Set(current.map(fileKey))
      return [...current, ...incoming.filter(file => !existing.has(fileKey(file)))]
    })
  }

  return (
    <form
      className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
      action={() => {
        const files = selectedFiles
        if (files.length === 0) {
          setMessage('Choose files')
          return
        }

        startTransition(() => {
          void Promise.all(
            files.map(file => {
              const formData = new FormData()
              formData.append('file', file)
              formData.append('pinned', pinned ? 'true' : 'false')
              return createFileKnowledgeRecordAction(formData)
            })
          ).then(results => {
            const failures = results.filter(result => result._tag === 'Error')
            if (failures.length === 0) {
              setSelectedFiles([])
              setMessage(files.length === 1 ? 'Saved file knowledge' : `Saved ${files.length} files`)
              if (inputRef.current !== null) {
                inputRef.current.value = ''
              }
            } else {
              setMessage(`${failures.length} failed: ${failures[0]?.message ?? 'Could not save files'}`)
            }
          })
        })
      }}
    >
      <div>
        <h2 className="font-medium">Add file knowledge</h2>
        <p className="text-sm text-muted-foreground">Upload files, store originals, and extract text for agent context.</p>
      </div>
      <div
        className={`rounded-xl border border-dashed p-6 text-center ${isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20'}`}
        onDragEnter={event => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragOver={event => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={event => {
          event.preventDefault()
          setIsDragging(false)
        }}
        onDrop={event => {
          event.preventDefault()
          setIsDragging(false)
          addFiles(event.dataTransfer.files)
        }}
      >
        <Input
          ref={inputRef}
          id="knowledge-file"
          name="file"
          type="file"
          accept={acceptedFileTypes}
          multiple
          className="sr-only"
          onChange={event => {
            if (event.currentTarget.files !== null) {
              addFiles(event.currentTarget.files)
            }
          }}
        />
        <Label htmlFor="knowledge-file" className="cursor-pointer text-sm font-medium">
          Drop files or click to browse
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">TXT, MD, CSV, JSON, PDF, DOCX, XLSX, PPTX · 2MB each</p>
      </div>
      {selectedFiles.length > 0 ? (
        <ul className="max-h-40 space-y-2 overflow-auto rounded-lg border p-2">
          {selectedFiles.map(file => (
            <li key={fileKey(file)} className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedFiles(files => files.filter(item => fileKey(item) !== fileKey(file)))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={pinned}
          onChange={event => setPinned(event.currentTarget.checked)}
        />
        Pin into agent context
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || selectedFiles.length === 0}>
          {isPending
            ? 'Saving…'
            : selectedFiles.length === 1
              ? 'Save 1 file'
              : `Save ${selectedFiles.length} files`}
        </Button>
        {message ? <p className="text-sm text-muted-foreground" aria-live="polite">{message}</p> : null}
      </div>
    </form>
  )
}
