/**
 * The published subset of the Afloat MCP tool catalog (internal data of the Afloat conformance
 * fixtures): nine of the tools the provider lists, the ones the MCP conformance cases and the file
 * workflow use, in the provider's listing order. Names, titles, input and output schemas, and
 * annotations are the provider's own wire values, derived from the provider's source
 * (owner-supplied); every description is rewritten generically. Annotation keys keep the source's
 * order; schema keys follow the sorted order of the source's schema snapshot, not necessarily the
 * live wire order. The live listing holds more tools.
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'

/** The nine published tools, in the provider's listing order. */
export const afloatMcpConformanceTools: ReadonlyArray<Schema.JsonObject> = [
  {
    name: 'list-invoices',
    title: 'List invoices',
    description:
      'List issued invoices, one page at a time, optionally filtered by search text or payment status.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        page: {
          description: 'a positive number',
          exclusiveMinimum: 0,
          title: 'positive',
          type: 'integer'
        },
        search: {
          type: 'string'
        },
        size: {
          enum: [10, 25, 50, 100],
          type: 'number'
        },
        status: {
          enum: ['all', 'paid', 'pending', 'overdue', 'voided'],
          type: 'string'
        }
      },
      required: [],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        items: {
          items: {
            additionalProperties: false,
            properties: {
              computedStatus: {
                enum: ['PAID', 'PENDING', 'OVERDUE', 'VOIDED'],
                type: 'string'
              },
              currency: {
                description: 'a string 3 character(s) long',
                maxLength: 3,
                minLength: 3,
                title: 'length(3)',
                type: 'string'
              },
              customer: {
                additionalProperties: false,
                properties: {
                  id: {
                    description: 'a string at most 128 character(s) long',
                    maxLength: 128,
                    minLength: 1,
                    title: 'maxLength(128)',
                    type: 'string'
                  },
                  name: {
                    type: 'string'
                  }
                },
                required: ['id', 'name'],
                type: 'object'
              },
              id: {
                description: 'a string at most 128 character(s) long',
                maxLength: 128,
                minLength: 1,
                title: 'maxLength(128)',
                type: 'string'
              },
              invoiceDate: {
                type: 'string'
              },
              invoiceDueDays: {
                description: 'an integer',
                title: 'int',
                type: 'integer'
              },
              invoiceNumber: {
                anyOf: [
                  {
                    description: 'an integer',
                    title: 'int',
                    type: 'integer'
                  },
                  {
                    type: 'null'
                  }
                ]
              },
              invoiceValue: {
                description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                pattern: '^-?\\d+(?:\\.\\d+)?$',
                type: 'string'
              },
              itemsValue: {
                description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                pattern: '^-?\\d+(?:\\.\\d+)?$',
                type: 'string'
              },
              notes: {
                anyOf: [
                  {
                    type: 'string'
                  },
                  {
                    type: 'null'
                  }
                ]
              },
              paymentCurrency: {
                anyOf: [
                  {
                    description: 'a string 3 character(s) long',
                    maxLength: 3,
                    minLength: 3,
                    title: 'length(3)',
                    type: 'string'
                  },
                  {
                    type: 'null'
                  }
                ]
              },
              paymentDate: {
                anyOf: [
                  {
                    type: 'string'
                  },
                  {
                    type: 'null'
                  }
                ]
              },
              paymentValue: {
                anyOf: [
                  {
                    description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                    pattern: '^-?\\d+(?:\\.\\d+)?$',
                    type: 'string'
                  },
                  {
                    type: 'null'
                  }
                ]
              },
              purchaseOrder: {
                anyOf: [
                  {
                    type: 'string'
                  },
                  {
                    type: 'null'
                  }
                ]
              },
              sequence: {
                additionalProperties: false,
                properties: {
                  prefix: {
                    type: 'string'
                  },
                  suffix: {
                    type: 'string'
                  }
                },
                required: ['prefix', 'suffix'],
                type: 'object'
              },
              status: {
                enum: ['ISSUED', 'VOIDED'],
                type: 'string'
              },
              taxPercentage: {
                description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                pattern: '^-?\\d+(?:\\.\\d+)?$',
                type: 'string'
              },
              updatedAt: {
                type: 'string'
              }
            },
            required: [
              'id',
              'invoiceNumber',
              'status',
              'computedStatus',
              'invoiceDate',
              'invoiceDueDays',
              'currency',
              'taxPercentage',
              'itemsValue',
              'invoiceValue',
              'paymentDate',
              'paymentValue',
              'paymentCurrency',
              'purchaseOrder',
              'notes',
              'customer',
              'sequence',
              'updatedAt'
            ],
            type: 'object'
          },
          type: 'array'
        },
        totalCount: {
          description: 'an integer',
          title: 'int',
          type: 'integer'
        }
      },
      required: ['items', 'totalCount'],
      type: 'object'
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get-invoice',
    title: 'Get invoice',
    description:
      'Read one invoice by id, with its line items, customer, vendor, and numbering sequence.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        invoiceId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        }
      },
      required: ['invoiceId'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        computedStatus: {
          enum: ['PAID', 'PENDING', 'OVERDUE', 'VOIDED'],
          type: 'string'
        },
        createdAt: {
          type: 'string'
        },
        currency: {
          description: 'a string 3 character(s) long',
          maxLength: 3,
          minLength: 3,
          title: 'length(3)',
          type: 'string'
        },
        customer: {
          additionalProperties: false,
          properties: {
            address: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ]
            },
            contact: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ]
            },
            id: {
              description: 'a string at most 128 character(s) long',
              maxLength: 128,
              minLength: 1,
              title: 'maxLength(128)',
              type: 'string'
            },
            name: {
              type: 'string'
            },
            taxNumber: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ]
            }
          },
          required: ['id', 'name', 'taxNumber', 'address', 'contact'],
          type: 'object'
        },
        id: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        },
        invoiceDate: {
          type: 'string'
        },
        invoiceDueDays: {
          description: 'an integer',
          title: 'int',
          type: 'integer'
        },
        invoiceNumber: {
          anyOf: [
            {
              description: 'an integer',
              title: 'int',
              type: 'integer'
            },
            {
              type: 'null'
            }
          ]
        },
        invoiceValue: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        items: {
          items: {
            additionalProperties: false,
            properties: {
              description: {
                anyOf: [
                  {
                    type: 'string'
                  },
                  {
                    type: 'null'
                  }
                ]
              },
              id: {
                description: 'a string at most 128 character(s) long',
                maxLength: 128,
                minLength: 1,
                title: 'maxLength(128)',
                type: 'string'
              },
              quantity: {
                description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                pattern: '^-?\\d+(?:\\.\\d+)?$',
                type: 'string'
              },
              taxPercentage: {
                description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                pattern: '^-?\\d+(?:\\.\\d+)?$',
                type: 'string'
              },
              title: {
                type: 'string'
              },
              totalValue: {
                description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                pattern: '^-?\\d+(?:\\.\\d+)?$',
                type: 'string'
              },
              unitValue: {
                description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
                pattern: '^-?\\d+(?:\\.\\d+)?$',
                type: 'string'
              }
            },
            required: [
              'id',
              'title',
              'description',
              'quantity',
              'unitValue',
              'taxPercentage',
              'totalValue'
            ],
            type: 'object'
          },
          type: 'array'
        },
        itemsValue: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        notes: {
          anyOf: [
            {
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        paymentCurrency: {
          anyOf: [
            {
              description: 'a string 3 character(s) long',
              maxLength: 3,
              minLength: 3,
              title: 'length(3)',
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        paymentDate: {
          anyOf: [
            {
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        paymentValue: {
          anyOf: [
            {
              description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
              pattern: '^-?\\d+(?:\\.\\d+)?$',
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        purchaseOrder: {
          anyOf: [
            {
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        secondTaxPercentage: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        sequence: {
          additionalProperties: false,
          properties: {
            id: {
              description: 'a string at most 128 character(s) long',
              maxLength: 128,
              minLength: 1,
              title: 'maxLength(128)',
              type: 'string'
            },
            name: {
              type: 'string'
            },
            prefix: {
              type: 'string'
            },
            suffix: {
              type: 'string'
            }
          },
          required: ['id', 'name', 'prefix', 'suffix'],
          type: 'object'
        },
        shippingTaxPercentage: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        shippingValue: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        status: {
          enum: ['DRAFT', 'ISSUED', 'VOIDED'],
          type: 'string'
        },
        taxPercentage: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        updatedAt: {
          type: 'string'
        },
        vendor: {
          additionalProperties: false,
          properties: {
            address: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ]
            },
            contact: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ]
            },
            id: {
              description: 'a string at most 128 character(s) long',
              maxLength: 128,
              minLength: 1,
              title: 'maxLength(128)',
              type: 'string'
            },
            name: {
              type: 'string'
            },
            paymentInfo: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ]
            },
            taxNumber: {
              anyOf: [
                {
                  type: 'string'
                },
                {
                  type: 'null'
                }
              ]
            }
          },
          required: ['id', 'name', 'taxNumber', 'address', 'contact', 'paymentInfo'],
          type: 'object'
        },
        voidedDate: {
          anyOf: [
            {
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        }
      },
      required: [
        'id',
        'invoiceNumber',
        'status',
        'computedStatus',
        'invoiceDate',
        'invoiceDueDays',
        'currency',
        'taxPercentage',
        'secondTaxPercentage',
        'shippingValue',
        'shippingTaxPercentage',
        'itemsValue',
        'invoiceValue',
        'paymentDate',
        'paymentValue',
        'paymentCurrency',
        'voidedDate',
        'purchaseOrder',
        'notes',
        'customer',
        'vendor',
        'sequence',
        'items',
        'createdAt',
        'updatedAt'
      ],
      type: 'object'
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get-tax-return-download',
    title: 'Get tax return download',
    description: 'Issue a short-lived download grant for a completed tax-return archive.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        taxReturnId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        }
      },
      required: ['taxReturnId'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expiresAt: {
          type: 'string'
        },
        url: {
          type: 'string'
        }
      },
      required: ['url', 'expiresAt'],
      type: 'object'
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'get-logo-download',
    title: 'Get logo download',
    description: 'Issue a short-lived download grant for a logo.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        logoId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        }
      },
      required: ['logoId'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expiresAt: {
          type: 'string'
        },
        url: {
          description: 'a string matching the pattern ^\\/mcp\\/files\\/logo\\/',
          pattern: '^\\/mcp\\/files\\/logo\\/',
          type: 'string'
        }
      },
      required: ['url', 'expiresAt'],
      type: 'object'
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'create-receipt-upload',
    title: 'Create receipt upload',
    description:
      'Start a receipt upload: answers a short-lived upload URL and the headers the upload must send.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        checksumSha256: {
          description: 'a string matching the pattern ^[A-Za-z0-9+/]{43}=$',
          maxLength: 44,
          minLength: 44,
          pattern: '^[A-Za-z0-9+/]{43}=$',
          title: 'length(44)',
          type: 'string'
        },
        contentLength: {
          description: 'a number between 1 and 2147483647',
          maximum: 2147483647,
          minimum: 1,
          title: 'between(1, 2147483647)',
          type: 'integer'
        },
        contentType: {
          enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
          type: 'string'
        }
      },
      required: ['contentType', 'contentLength'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expiresAt: {
          type: 'string'
        },
        requiredHeaders: {
          additionalProperties: false,
          properties: {
            'content-length': {
              description: 'a string matching the pattern ^\\d+$',
              pattern: '^\\d+$',
              type: 'string'
            },
            'content-type': {
              enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
              type: 'string'
            },
            'x-amz-checksum-sha256': {
              type: 'string'
            }
          },
          required: ['content-type', 'content-length'],
          type: 'object'
        },
        uploadIntentId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        },
        uploadUrl: {
          description: 'a string at least 1 character(s) long',
          minLength: 1,
          title: 'minLength(1)',
          type: 'string'
        }
      },
      required: ['uploadIntentId', 'uploadUrl', 'expiresAt', 'requiredHeaders'],
      type: 'object'
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'complete-receipt-upload',
    title: 'Complete receipt upload',
    description: 'Finish a receipt upload and attach the uploaded file to an expense.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expenseId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        },
        uploadIntentId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        }
      },
      required: ['expenseId', 'uploadIntentId'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        createdAt: {
          type: 'string'
        },
        hasReceipt: {
          type: 'boolean'
        },
        id: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        },
        payee: {
          additionalProperties: false,
          properties: {
            id: {
              description: 'a string at most 128 character(s) long',
              maxLength: 128,
              minLength: 1,
              title: 'maxLength(128)',
              type: 'string'
            },
            name: {
              type: 'string'
            }
          },
          required: ['id', 'name'],
          type: 'object'
        },
        paymentCurrency: {
          anyOf: [
            {
              description: 'a string 3 character(s) long',
              maxLength: 3,
              minLength: 3,
              title: 'length(3)',
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        paymentDate: {
          anyOf: [
            {
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        paymentValue: {
          anyOf: [
            {
              description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
              pattern: '^-?\\d+(?:\\.\\d+)?$',
              type: 'string'
            },
            {
              type: 'null'
            }
          ]
        },
        receiptCurrency: {
          description: 'a string 3 character(s) long',
          maxLength: 3,
          minLength: 3,
          title: 'length(3)',
          type: 'string'
        },
        receiptSubtotalValue: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        receiptValue: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        rounding: {
          anyOf: [
            {
              type: 'number'
            },
            {
              type: 'null'
            }
          ]
        },
        status: {
          enum: ['PAID', 'PENDING'],
          type: 'string'
        },
        tags: {
          items: {
            type: 'string'
          },
          type: 'array'
        },
        taxPercentage: {
          description: 'a string matching the pattern ^-?\\d+(?:\\.\\d+)?$',
          pattern: '^-?\\d+(?:\\.\\d+)?$',
          type: 'string'
        },
        updatedAt: {
          type: 'string'
        }
      },
      required: [
        'id',
        'status',
        'receiptSubtotalValue',
        'receiptValue',
        'receiptCurrency',
        'taxPercentage',
        'paymentDate',
        'paymentValue',
        'paymentCurrency',
        'rounding',
        'hasReceipt',
        'payee',
        'tags',
        'createdAt',
        'updatedAt'
      ],
      type: 'object'
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'get-receipt-download',
    title: 'Get receipt download',
    description: 'Issue a short-lived download grant for the receipt attached to an expense.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expenseId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        }
      },
      required: ['expenseId'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expiresAt: {
          type: 'string'
        },
        url: {
          description: 'a string matching the pattern ^\\/mcp\\/files\\/receipt\\/',
          pattern: '^\\/mcp\\/files\\/receipt\\/',
          type: 'string'
        }
      },
      required: ['url', 'expiresAt'],
      type: 'object'
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'get-invoice-pdf',
    title: 'Get invoice PDF',
    description: 'Issue a short-lived download grant for an invoice PDF.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        invoiceId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        }
      },
      required: ['invoiceId'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expiresAt: {
          type: 'string'
        },
        url: {
          description: 'a string matching the pattern ^\\/mcp\\/files\\/pdf\\/',
          pattern: '^\\/mcp\\/files\\/pdf\\/',
          type: 'string'
        }
      },
      required: ['url', 'expiresAt'],
      type: 'object'
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'get-quote-pdf',
    title: 'Get quote PDF',
    description: 'Issue a short-lived download grant for a quote PDF.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        quoteId: {
          description: 'a string at most 128 character(s) long',
          maxLength: 128,
          minLength: 1,
          title: 'maxLength(128)',
          type: 'string'
        }
      },
      required: ['quoteId'],
      type: 'object'
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        expiresAt: {
          type: 'string'
        },
        url: {
          description: 'a string matching the pattern ^\\/mcp\\/files\\/pdf\\/',
          pattern: '^\\/mcp\\/files\\/pdf\\/',
          type: 'string'
        }
      },
      required: ['url', 'expiresAt'],
      type: 'object'
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  }
]
