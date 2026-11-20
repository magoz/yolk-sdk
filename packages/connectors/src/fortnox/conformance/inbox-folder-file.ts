import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The inbox root, its first static subfolders up to the first holding a file, and that file’s
 * bytes.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) shaped from the Fortnox API reference
 * (https://api.fortnox.se/apidocs, OpenAPI 3.0.3) and the JSON examples of the archived resource
 * pages (developer.fortnox.se/documentation/resources, Wayback Machine, 2022-08), until a live
 * recording replaces it. The bodies were first rendered by the Fortnox emulator's default seed
 * (which fixed their key order, `@url` links, and extra fields), then checked against that
 * reference: every field name is in the OpenAPI schema; where its types and the examples disagree
 * (numeric strings in article list rows, payments, and mode of payment list rows) and for
 * `MetaInformation` (which the OpenAPI list wrappers omit), the fixture follows the examples and
 * the connector's decoders. The fixture is the source of the emulator's read answers
 * (`@yolk-sdk/emulators/fortnox` must answer its requests byte for byte); change it only for a
 * cited spec or live-run reason.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const fortnoxInboxFolderFileBytesFixture: WireFixture = {
  id: 'fortnox.inbox.file-bytes-match-size.synthetic',
  caseId: 'fortnox.inbox.file-bytes-match-size',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Inbox root, subfolders in order until one holds a file, then the file content through the binary port. Shaped from the Fortnox API reference (GET /3/inbox, /3/inbox/{Id}, Folder, File). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/inbox',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Folder":{"@url":"https://api.fortnox.se/3/inbox/root","Email":"root.100001@inbox.example.test","Files":[],"Folders":[{"@url":"https://api.fortnox.se/3/inbox/inbox_a","Email":"inbox_a.100001@inbox.example.test","Id":"inbox_a","Name":"Asset register (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_d","Email":"inbox_d.100001@inbox.example.test","Id":"inbox_d","Name":"Daily takings (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_s","Email":"inbox_s.100001@inbox.example.test","Id":"inbox_s","Name":"Supplier invoices (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_v","Email":"inbox_v.100001@inbox.example.test","Id":"inbox_v","Name":"Vouchers (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_b","Email":"inbox_b.100001@inbox.example.test","Id":"inbox_b","Name":"Bank files (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_l","Email":"inbox_l.100001@inbox.example.test","Id":"inbox_l","Name":"Payroll (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_kf","Email":"inbox_kf.100001@inbox.example.test","Id":"inbox_kf","Name":"Customer invoices (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_o","Email":"inbox_o.100001@inbox.example.test","Id":"inbox_o","Name":"Orders (synthetic)"},{"@url":"https://api.fortnox.se/3/inbox/inbox_of","Email":"inbox_of.100001@inbox.example.test","Id":"inbox_of","Name":"Offers (synthetic)"}],"Id":"root","Name":"Inbox"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/inbox/inbox_a',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Folder":{"@url":"https://api.fortnox.se/3/inbox/inbox_a","Email":"inbox_a.100001@inbox.example.test","Files":[],"Folders":[],"Id":"inbox_a","Name":"Asset register (synthetic)"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/inbox/inbox_d',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Folder":{"@url":"https://api.fortnox.se/3/inbox/inbox_d","Email":"inbox_d.100001@inbox.example.test","Files":[],"Folders":[],"Id":"inbox_d","Name":"Daily takings (synthetic)"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/inbox/inbox_s',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Folder":{"@url":"https://api.fortnox.se/3/inbox/inbox_s","Email":"inbox_s.100001@inbox.example.test","Files":[{"@url":"https://api.fortnox.se/3/inbox/00000000-0000-4000-8000-000000000001","ArchiveFileId":"00000000-0000-4000-8000-000000000101","Comments":"","Id":"00000000-0000-4000-8000-000000000001","Name":"supplier-invoice-synthetic.txt","Path":"inbox_s/supplier-invoice-synthetic.txt","Size":68}],"Folders":[],"Id":"inbox_s","Name":"Supplier invoices (synthetic)"}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/inbox/00000000-0000-4000-8000-000000000001',
        headers: {
          accept: 'application/octet-stream'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream'
        },
        body: 'Synthetic supplier invoice from Example Supplier AB (example.test).\n'
      }
    }
  ]
}
