/**
 * The email conformance fixtures, copied as data (internal; re-exported by `email.ts`).
 *
 * Emulators never import SDK code: this is a verbatim copy of `emailConformanceFixtures` from
 * `@yolk-sdk/connectors/email/conformance` (synthetic `PortFixture`s; none observed live).
 * `test/email-conformance.test.ts` fails when the two drift apart; update both together.
 */
import type * as Schema from 'effect/Schema'

/** A port failure as a fixture records it (mirrors `PortFailure` in `@yolk-sdk/conformance`). */
export type EmailEmulatorFailure = {
  readonly kind: 'expected' | 'error'
  readonly code: string
  readonly message: string
  readonly status?: number
}

type EmailEmulatorFixtureFields = {
  readonly id: string
  readonly port: string
  readonly method: string
  readonly request: Schema.Json
  readonly observed?: { readonly account: string; readonly date: string }
  readonly note?: string
}

/**
 * One recorded `EmailClient` call (the plain-JSON shape of a `PortFixture`): exactly one of
 * `response` or `failure`.
 */
export type EmailEmulatorFixture =
  | (EmailEmulatorFixtureFields & { readonly response: Schema.Json; readonly failure?: never })
  | (EmailEmulatorFixtureFields & {
      readonly failure: EmailEmulatorFailure
      readonly response?: never
    })

export const emailEmulatorFixtures: ReadonlyArray<EmailEmulatorFixture> = [
  {
    id: 'email.imap.list-and-get-headers.list.synthetic',
    port: 'EmailClient',
    method: 'listMessages',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      limit: 50
    },
    response: {
      messages: [
        {
          id: '1700000001:41',
          subject: 'Synthetic welcome',
          from: [
            {
              address: 'sender@example.test',
              name: 'Synthetic Sender'
            }
          ],
          to: [
            {
              address: 'practice@example.test'
            }
          ],
          sentAt: '2026-09-28T08:00:00.000Z',
          receivedAt: '2026-09-28T08:00:05.000Z',
          snippet: 'Welcome to the synthetic practice mailbox.',
          hasAttachments: false,
          isRead: false,
          isFlagged: false
        },
        {
          id: '1700000001:42',
          subject: 'Synthetic weekly summary',
          from: [
            {
              address: 'sender@example.test',
              name: 'Synthetic Sender'
            }
          ],
          to: [
            {
              address: 'practice@example.test'
            }
          ],
          sentAt: '2026-09-29T08:00:00.000Z',
          receivedAt: '2026-09-29T08:00:04.000Z',
          snippet: 'Nothing happened this synthetic week.',
          hasAttachments: false,
          isRead: true,
          isFlagged: false
        }
      ]
    },
    note: 'Unfiltered INBOX list: the seeded unread message and one read message. Synthetic.'
  },
  {
    id: 'email.imap.list-and-get-headers.get.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41'
    },
    response: {
      message: {
        id: '1700000001:41',
        messageId: '<welcome.0001@example.test>',
        subject: 'Synthetic welcome',
        from: [
          {
            address: 'sender@example.test',
            name: 'Synthetic Sender'
          }
        ],
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-28T08:00:00.000Z',
        receivedAt: '2026-09-28T08:00:05.000Z',
        body: {
          text: 'Welcome to the synthetic practice mailbox.'
        },
        attachments: [],
        isRead: false,
        isFlagged: false,
        headers: [
          {
            name: 'Date',
            value: 'Mon, 28 Sep 2026 08:00:00 +0000'
          },
          {
            name: 'From',
            value: 'Synthetic Sender <sender@example.test>'
          },
          {
            name: 'To',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'Synthetic welcome'
          },
          {
            name: 'Message-ID',
            value: '<welcome.0001@example.test>'
          }
        ]
      }
    },
    note: 'Get of the seeded unread message with its header fields (BODY.PEEK[HEADER]). Synthetic.'
  },
  {
    id: 'email.imap.list-and-get-headers.list-again.synthetic',
    port: 'EmailClient',
    method: 'listMessages',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      limit: 50
    },
    response: {
      messages: [
        {
          id: '1700000001:41',
          subject: 'Synthetic welcome',
          from: [
            {
              address: 'sender@example.test',
              name: 'Synthetic Sender'
            }
          ],
          to: [
            {
              address: 'practice@example.test'
            }
          ],
          sentAt: '2026-09-28T08:00:00.000Z',
          receivedAt: '2026-09-28T08:00:05.000Z',
          snippet: 'Welcome to the synthetic practice mailbox.',
          hasAttachments: false,
          isRead: false,
          isFlagged: false
        },
        {
          id: '1700000001:42',
          subject: 'Synthetic weekly summary',
          from: [
            {
              address: 'sender@example.test',
              name: 'Synthetic Sender'
            }
          ],
          to: [
            {
              address: 'practice@example.test'
            }
          ],
          sentAt: '2026-09-29T08:00:00.000Z',
          receivedAt: '2026-09-29T08:00:04.000Z',
          snippet: 'Nothing happened this synthetic week.',
          hasAttachments: false,
          isRead: true,
          isFlagged: false
        }
      ]
    },
    note: 'The same INBOX list after the get: the message is still unread. Synthetic.'
  },
  {
    id: 'email.imap.filtered-list-no-fallback.list-unread.synthetic',
    port: 'EmailClient',
    method: 'listMessagesFiltered',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      limit: 50,
      isRead: false
    },
    response: {
      messages: [
        {
          id: '1700000001:41',
          subject: 'Synthetic welcome',
          from: [
            {
              address: 'sender@example.test',
              name: 'Synthetic Sender'
            }
          ],
          to: [
            {
              address: 'practice@example.test'
            }
          ],
          sentAt: '2026-09-28T08:00:00.000Z',
          receivedAt: '2026-09-28T08:00:05.000Z',
          snippet: 'Welcome to the synthetic practice mailbox.',
          hasAttachments: false,
          isRead: false,
          isFlagged: false
        }
      ]
    },
    note: 'Filtered INBOX list (UID SEARCH UNSEEN): only the seeded unread message. Synthetic.'
  },
  {
    id: 'email.imap.draft-drafts-discovery.create.synthetic',
    port: 'EmailClient',
    method: 'createDraft',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      message: {
        to: [],
        subject: 'yolk-conformance draft discovery: safe to delete',
        body: {
          text: 'Synthetic conformance draft; never sent.'
        }
      }
    },
    response: {
      saved: true,
      folder: 'Saved Drafts',
      draftId: '1700000002:7'
    },
    note: 'APPEND (\\Draft) to the mailbox LIST advertises as \\Drafts; UIDPLUS APPENDUID gives the id. Synthetic.'
  },
  {
    id: 'email.imap.draft-drafts-discovery.get.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000002:7',
      folder: 'Saved Drafts'
    },
    response: {
      message: {
        id: '1700000002:7',
        messageId: '<draft.0007@example.test>',
        subject: 'yolk-conformance draft discovery: safe to delete',
        from: [
          {
            address: 'practice@example.test'
          }
        ],
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-30T09:00:00.000Z',
        body: {
          text: 'Synthetic conformance draft; never sent.'
        },
        attachments: [],
        isRead: true,
        isFlagged: false,
        headers: [
          {
            name: 'Date',
            value: 'Wed, 30 Sep 2026 09:00:00 +0000'
          },
          {
            name: 'From',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'yolk-conformance draft discovery: safe to delete'
          },
          {
            name: 'Message-ID',
            value: '<draft.0007@example.test>'
          }
        ]
      }
    },
    note: 'The saved draft read back by its draftId. Synthetic.'
  },
  {
    id: 'email.imap.draft-drafts-discovery.delete.synthetic',
    port: 'EmailClient',
    method: 'deletePermanently',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageIds: ['1700000002:7'],
      folder: 'Saved Drafts'
    },
    response: {
      results: [
        {
          messageId: '1700000002:7',
          status: 'succeeded'
        }
      ],
      summary: {
        requested: 1,
        succeeded: 1,
        failed: 0,
        unknown: 0,
        notAttempted: 0
      }
    },
    note: 'Restore: UID-scoped permanent delete of the case-created draft. Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.get-before.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41'
    },
    response: {
      message: {
        id: '1700000001:41',
        messageId: '<welcome.0001@example.test>',
        subject: 'Synthetic welcome',
        from: [
          {
            address: 'sender@example.test',
            name: 'Synthetic Sender'
          }
        ],
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-28T08:00:00.000Z',
        receivedAt: '2026-09-28T08:00:05.000Z',
        body: {
          text: 'Welcome to the synthetic practice mailbox.'
        },
        attachments: [],
        isRead: false,
        isFlagged: false,
        headers: [
          {
            name: 'Date',
            value: 'Mon, 28 Sep 2026 08:00:00 +0000'
          },
          {
            name: 'From',
            value: 'Synthetic Sender <sender@example.test>'
          },
          {
            name: 'To',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'Synthetic welcome'
          },
          {
            name: 'Message-ID',
            value: '<welcome.0001@example.test>'
          }
        ]
      }
    },
    note: 'Get of the seeded message (read false, flagged false). Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.set-read.synthetic',
    port: 'EmailClient',
    method: 'setRead',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41',
      folder: 'INBOX',
      isRead: true
    },
    response: {
      messageId: '1700000001:41',
      isRead: true
    },
    note: 'UID STORE +FLAGS.SILENT (\\Seen). Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.get-read.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41'
    },
    response: {
      message: {
        id: '1700000001:41',
        messageId: '<welcome.0001@example.test>',
        subject: 'Synthetic welcome',
        from: [
          {
            address: 'sender@example.test',
            name: 'Synthetic Sender'
          }
        ],
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-28T08:00:00.000Z',
        receivedAt: '2026-09-28T08:00:05.000Z',
        body: {
          text: 'Welcome to the synthetic practice mailbox.'
        },
        attachments: [],
        isRead: true,
        isFlagged: false,
        headers: [
          {
            name: 'Date',
            value: 'Mon, 28 Sep 2026 08:00:00 +0000'
          },
          {
            name: 'From',
            value: 'Synthetic Sender <sender@example.test>'
          },
          {
            name: 'To',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'Synthetic welcome'
          },
          {
            name: 'Message-ID',
            value: '<welcome.0001@example.test>'
          }
        ]
      }
    },
    note: 'Get of the seeded message (read true, flagged false). Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.set-flag.synthetic',
    port: 'EmailClient',
    method: 'setFlag',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41',
      folder: 'INBOX',
      isFlagged: true
    },
    response: {
      messageId: '1700000001:41',
      isFlagged: true
    },
    note: 'UID STORE +FLAGS.SILENT (\\Flagged). Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.get-flagged.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41'
    },
    response: {
      message: {
        id: '1700000001:41',
        messageId: '<welcome.0001@example.test>',
        subject: 'Synthetic welcome',
        from: [
          {
            address: 'sender@example.test',
            name: 'Synthetic Sender'
          }
        ],
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-28T08:00:00.000Z',
        receivedAt: '2026-09-28T08:00:05.000Z',
        body: {
          text: 'Welcome to the synthetic practice mailbox.'
        },
        attachments: [],
        isRead: true,
        isFlagged: true,
        headers: [
          {
            name: 'Date',
            value: 'Mon, 28 Sep 2026 08:00:00 +0000'
          },
          {
            name: 'From',
            value: 'Synthetic Sender <sender@example.test>'
          },
          {
            name: 'To',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'Synthetic welcome'
          },
          {
            name: 'Message-ID',
            value: '<welcome.0001@example.test>'
          }
        ]
      }
    },
    note: 'Get of the seeded message (read true, flagged true). Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.restore-read.synthetic',
    port: 'EmailClient',
    method: 'setRead',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41',
      folder: 'INBOX',
      isRead: false
    },
    response: {
      messageId: '1700000001:41',
      isRead: false
    },
    note: 'UID STORE -FLAGS.SILENT (\\Seen). Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.restore-flag.synthetic',
    port: 'EmailClient',
    method: 'setFlag',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41',
      folder: 'INBOX',
      isFlagged: false
    },
    response: {
      messageId: '1700000001:41',
      isFlagged: false
    },
    note: 'UID STORE -FLAGS.SILENT (\\Flagged). Synthetic.'
  },
  {
    id: 'email.imap.set-read-and-flag.get-restored.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:41'
    },
    response: {
      message: {
        id: '1700000001:41',
        messageId: '<welcome.0001@example.test>',
        subject: 'Synthetic welcome',
        from: [
          {
            address: 'sender@example.test',
            name: 'Synthetic Sender'
          }
        ],
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-28T08:00:00.000Z',
        receivedAt: '2026-09-28T08:00:05.000Z',
        body: {
          text: 'Welcome to the synthetic practice mailbox.'
        },
        attachments: [],
        isRead: false,
        isFlagged: false,
        headers: [
          {
            name: 'Date',
            value: 'Mon, 28 Sep 2026 08:00:00 +0000'
          },
          {
            name: 'From',
            value: 'Synthetic Sender <sender@example.test>'
          },
          {
            name: 'To',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'Synthetic welcome'
          },
          {
            name: 'Message-ID',
            value: '<welcome.0001@example.test>'
          }
        ]
      }
    },
    note: 'Get of the seeded message (read false, flagged false). Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.create.synthetic',
    port: 'EmailClient',
    method: 'createDraft',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      message: {
        to: [],
        subject: 'yolk-conformance trash probe: safe to delete',
        body: {
          text: 'Synthetic conformance draft; never sent.'
        }
      },
      folder: 'Saved Drafts'
    },
    response: {
      saved: true,
      folder: 'Saved Drafts',
      draftId: '1700000002:8'
    },
    note: 'The case-owned draft in the seeded Drafts mailbox. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.trash.synthetic',
    port: 'EmailClient',
    method: 'trash',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000002:8',
      folder: 'Saved Drafts'
    },
    response: {
      moved: true,
      folder: 'Deleted Items',
      messageId: '1700000004:3'
    },
    note: 'UID MOVE to the mailbox LIST advertises as \\Trash; COPYUID gives the destination id. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.untrash.synthetic',
    port: 'EmailClient',
    method: 'untrash',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000004:3',
      folder: 'Deleted Items',
      destinationFolder: 'INBOX'
    },
    response: {
      moved: true,
      folder: 'INBOX',
      messageId: '1700000001:43'
    },
    note: 'Restore defaults to INBOX, not the original Drafts mailbox. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.get.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000001:43'
    },
    response: {
      message: {
        id: '1700000001:43',
        messageId: '<draft.0008@example.test>',
        subject: 'yolk-conformance trash probe: safe to delete',
        from: [
          {
            address: 'practice@example.test'
          }
        ],
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-30T09:00:00.000Z',
        body: {
          text: 'Synthetic conformance draft; never sent.'
        },
        attachments: [],
        isRead: true,
        isFlagged: false,
        headers: [
          {
            name: 'Date',
            value: 'Wed, 30 Sep 2026 09:00:00 +0000'
          },
          {
            name: 'From',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'yolk-conformance trash probe: safe to delete'
          },
          {
            name: 'Message-ID',
            value: '<draft.0008@example.test>'
          }
        ]
      }
    },
    note: 'The restored message read back in INBOX by its new id. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.delete.synthetic',
    port: 'EmailClient',
    method: 'deletePermanently',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageIds: ['1700000001:43'],
      folder: 'INBOX'
    },
    response: {
      results: [
        {
          messageId: '1700000001:43',
          status: 'succeeded'
        }
      ],
      summary: {
        requested: 1,
        succeeded: 1,
        failed: 0,
        unknown: 0,
        notAttempted: 0
      }
    },
    note: 'Restore: UID-scoped permanent delete where the message ended up. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.create.synthetic',
    port: 'EmailClient',
    method: 'createDraft',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      message: {
        to: [],
        subject: 'yolk-conformance move probe: safe to delete',
        body: {
          text: 'Synthetic conformance draft; never sent.'
        }
      },
      folder: 'Saved Drafts'
    },
    response: {
      saved: true,
      folder: 'Saved Drafts',
      draftId: '1700000002:9'
    },
    note: 'The case-owned draft in the seeded Drafts mailbox. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.move.synthetic',
    port: 'EmailClient',
    method: 'move',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000002:9',
      folder: 'Saved Drafts',
      destinationFolder: 'Archive'
    },
    response: {
      moved: true,
      folder: 'Archive',
      messageId: '1700000005:12'
    },
    note: 'UID MOVE (RFC 6851); COPYUID gives the destination UIDVALIDITY:UID. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.get-destination.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000005:12',
      folder: 'Archive'
    },
    response: {
      message: {
        id: '1700000005:12',
        messageId: '<draft.0009@example.test>',
        subject: 'yolk-conformance move probe: safe to delete',
        from: [
          {
            address: 'practice@example.test'
          }
        ],
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        sentAt: '2026-09-30T09:00:00.000Z',
        body: {
          text: 'Synthetic conformance draft; never sent.'
        },
        attachments: [],
        isRead: true,
        isFlagged: false,
        headers: [
          {
            name: 'Date',
            value: 'Wed, 30 Sep 2026 09:00:00 +0000'
          },
          {
            name: 'From',
            value: 'practice@example.test'
          },
          {
            name: 'Subject',
            value: 'yolk-conformance move probe: safe to delete'
          },
          {
            name: 'Message-ID',
            value: '<draft.0009@example.test>'
          }
        ]
      }
    },
    note: 'The moved message read back by its destination id. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.get-stale-source.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageId: '1700000002:9',
      folder: 'Saved Drafts'
    },
    failure: {
      kind: 'expected',
      code: 'message_not_found',
      message: 'No message with that UID in the mailbox.'
    },
    note: 'The stale source id no longer resolves after the move. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.delete.synthetic',
    port: 'EmailClient',
    method: 'deletePermanently',
    request: {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      messageIds: ['1700000005:12'],
      folder: 'Archive'
    },
    response: {
      results: [
        {
          messageId: '1700000005:12',
          status: 'succeeded'
        }
      ],
      summary: {
        requested: 1,
        succeeded: 1,
        failed: 0,
        unknown: 0,
        notAttempted: 0
      }
    },
    note: 'Restore: UID-scoped permanent delete in the destination. Synthetic.'
  },
  {
    id: 'email.pop3.rejects-folders-drafts-mutations.list.synthetic',
    port: 'EmailClient',
    method: 'listMessages',
    request: {
      connection: {
        protocol: 'pop3',
        host: 'pop3.example.test',
        port: 995,
        security: 'tls'
      },
      limit: 50
    },
    response: {
      messages: [
        {
          id: 'uidl-synthetic-0041',
          subject: 'Synthetic welcome',
          from: [
            {
              address: 'sender@example.test',
              name: 'Synthetic Sender'
            }
          ],
          to: [
            {
              address: 'practice@example.test'
            }
          ],
          sentAt: '2026-09-28T08:00:00.000Z',
          hasAttachments: false
        },
        {
          id: 'uidl-synthetic-0042',
          subject: 'Synthetic weekly summary',
          from: [
            {
              address: 'sender@example.test',
              name: 'Synthetic Sender'
            }
          ],
          to: [
            {
              address: 'practice@example.test'
            }
          ],
          sentAt: '2026-09-29T08:00:00.000Z',
          hasAttachments: false
        }
      ]
    },
    note: 'POP3 maildrop list (UIDL plus TOP headers); POP3 has no read or flagged state. Synthetic.'
  },
  {
    id: 'email.smtp.sent-copy-statuses.send-saved.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: {
        protocol: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls'
      },
      message: {
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        subject: 'yolk-conformance send: saved copy',
        body: {
          text: 'Synthetic conformance message to the practice mailbox.'
        }
      },
      sentCopy: {
        connection: {
          protocol: 'imap',
          host: 'imap.example.test',
          port: 993,
          security: 'tls'
        }
      }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0001',
      sentCopy: {
        status: 'saved',
        folder: 'Sent Items'
      }
    },
    note: 'SMTP 250 after DATA, then APPEND of the same bytes to the mailbox LIST advertises as \\Sent. Synthetic.'
  },
  {
    id: 'email.smtp.sent-copy-statuses.send-skipped.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: {
        protocol: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls'
      },
      message: {
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        subject: 'yolk-conformance send: copy skipped',
        body: {
          text: 'Synthetic conformance message to the practice mailbox.'
        }
      }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0002'
    },
    note: 'No sentCopy requested, none reported; the action synthesizes skipped. Synthetic.'
  },
  {
    id: 'email.smtp.sent-copy-statuses.send-failed.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: {
        protocol: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls'
      },
      message: {
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        subject: 'yolk-conformance send: copy fails',
        body: {
          text: 'Synthetic conformance message to the practice mailbox.'
        }
      },
      sentCopy: {
        connection: {
          protocol: 'imap',
          host: 'imap.example.test',
          port: 993,
          security: 'tls'
        },
        folder: 'yolk-conformance-missing-sent-folder'
      }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0003',
      sentCopy: {
        status: 'failed',
        folder: 'yolk-conformance-missing-sent-folder'
      }
    },
    note: 'SMTP accepted; APPEND answered NO [TRYCREATE], so the copy failed (never resend). Synthetic.'
  },
  {
    id: 'email.smtp.legacy-host-sent-copy.send-requested.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: {
        protocol: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls'
      },
      message: {
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        subject: 'yolk-conformance send: legacy host, copy requested',
        body: {
          text: 'Synthetic legacy-host conformance message.'
        }
      }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0004'
    },
    note: 'What the host sees behind the legacy shim: no sentCopy in, none out. Synthetic.'
  },
  {
    id: 'email.smtp.legacy-host-sent-copy.send-disabled.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: {
        protocol: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls'
      },
      message: {
        to: [
          {
            address: 'practice@example.test'
          }
        ],
        subject: 'yolk-conformance send: legacy host, copy disabled',
        body: {
          text: 'Synthetic legacy-host conformance message.'
        }
      }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0005'
    },
    note: 'What the host sees behind the legacy shim: no sentCopy in, none out. Synthetic.'
  },
  {
    id: 'email.smtp.acceptance-not-delivery.send.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: {
        protocol: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls'
      },
      message: {
        to: [
          {
            address: 'nobody@undeliverable.example.test'
          }
        ],
        subject: 'yolk-conformance send: accepted, undeliverable',
        body: {
          text: 'Synthetic conformance message to an undeliverable address.'
        }
      }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0006'
    },
    note: 'SMTP 250 for the submission; the bounce (DSN) would arrive later. Synthetic.'
  }
]
