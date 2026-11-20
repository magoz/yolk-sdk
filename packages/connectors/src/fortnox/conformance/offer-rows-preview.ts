import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One page of offers (limit 10, rows without `OfferRows`), the first offer read back with its rows,
 * and its preview PDF (`bodyBase64`, the invoice preview fixture’s bytes).
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
export const fortnoxOfferRowsAndPreviewFixture: WireFixture = {
  id: 'fortnox.offer.rows-on-get-and-preview-pdf.synthetic',
  caseId: 'fortnox.offer.rows-on-get-and-preview-pdf',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Offer list (limit 10), the first offer, then its preview through the binary port. Shaped from the Fortnox API reference (GET /3/offers, OfferListItem; GET /3/offers/{DocumentNumber}, Offer; GET /3/offers/{DocumentNumber}/preview). Synthetic placeholder (bodies first rendered by the Fortnox emulator default seed, then checked against the reference); not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/offers?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Offers":[{"@url":"https://api.fortnox.se/3/offers/1","Cancelled":false,"CostCenter":"CC1","Currency":"SEK","CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"1","OfferDate":"2026-09-01","Project":"","Sent":true,"Total":12438},{"@url":"https://api.fortnox.se/3/offers/2","Cancelled":false,"CostCenter":"","Currency":"SEK","CustomerName":"Example Trading AB","CustomerNumber":"1002","DocumentNumber":"2","OfferDate":"2026-09-20","Project":"","Sent":false,"Total":5500},{"@url":"https://api.fortnox.se/3/offers/3","Cancelled":true,"CostCenter":"","Currency":"SEK","CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"3","OfferDate":"2026-08-01","Project":"","Sent":false,"Total":125}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":3}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/offers/1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Offer":{"@url":"https://api.fortnox.se/3/offers/1","DocumentNumber":"1","CustomerNumber":"1001","CustomerName":"Example Customer AB","OfferDate":"2026-09-01","ExpireDate":"2026-09-30","DeliveryDate":null,"Currency":"SEK","CurrencyRate":1,"VATIncluded":false,"Cancelled":false,"Sent":true,"NotCompleted":false,"OrderReference":"0","InvoiceReference":"0","OurReference":"Example Seller","YourReference":"","Comments":"Synthetic offer.","Remarks":"","CostCenter":"CC1","Project":"","EmailInformation":{"EmailAddressFrom":"offers@example.test","EmailAddressTo":"billing@example.test","EmailAddressCC":"","EmailAddressBCC":"","EmailSubject":"Offer {no} from Example AB"},"OfferRows":[{"RowId":1,"ArticleNumber":"SRV-1","AccountNumber":3001,"Description":"Consulting hour (synthetic)","Quantity":"10.00","Unit":"h","Price":950,"Discount":0,"DiscountType":"PERCENT","VAT":25,"Total":9500,"CostCenter":"","Project":""},{"RowId":2,"ArticleNumber":"KIT-1","AccountNumber":3001,"Description":"Workshop kit (synthetic)","Quantity":"2.00","Unit":"st","Price":250,"Discount":10,"DiscountType":"PERCENT","VAT":25,"Total":450,"CostCenter":"","Project":""}],"Net":9950,"Gross":9950,"TotalVAT":2487.5,"Total":12438,"TotalToPay":12438}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/offers/1/preview'
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/pdf'
        },
        bodyBase64:
          'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFtdIC9Db3VudCAwID4+CmVuZG9iagp0cmFpbGVyCjw8IC9Sb290IDEgMCBSID4+CiUlRU9GCg=='
      }
    }
  ]
}
