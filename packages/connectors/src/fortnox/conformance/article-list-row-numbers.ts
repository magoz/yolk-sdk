import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One page of articles (limit 10) whose rows send amounts as numeric strings, then the first
 * article read back with JSON numbers.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) shaped from the Fortnox API reference
 * (https://api.fortnox.se/apidocs, OpenAPI 3.0.3) and the JSON examples of the archived resource
 * pages (developer.fortnox.se/documentation/resources, Wayback Machine, 2022-08), with the values
 * of the Fortnox emulator default seed, until a live recording replaces it. Every field name is in
 * the OpenAPI schema; where its types and the examples disagree (numeric strings in article list
 * rows, payments, and mode of payment list rows) and for `MetaInformation` (which the OpenAPI list
 * wrappers omit), the fixture follows the examples and the connector's decoders.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const fortnoxArticleListRowNumbersFixture: WireFixture = {
  id: 'fortnox.article.list-row-numeric-strings.synthetic',
  caseId: 'fortnox.article.list-row-numeric-strings',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Article list (limit 10), then the first article. Shaped from the Fortnox API reference (GET /3/articles, ArticleListItem; GET /3/articles/{ArticleNumber}, Article) and its examples (numeric strings in list rows). Synthetic placeholder with the Fortnox emulator default seed values; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/articles?limit=10',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Articles":[{"@url":"https://api.fortnox.se/3/articles/KIT-1","ArticleNumber":"KIT-1","Description":"Workshop kit (synthetic)","EAN":"2000000000015","PurchasePrice":"120","QuantityInStock":"15","SalesPrice":"250","Unit":"st","VAT":"25"},{"@url":"https://api.fortnox.se/3/articles/SRV-1","ArticleNumber":"SRV-1","Description":"Consulting hour (synthetic)","EAN":"","PurchasePrice":"0","QuantityInStock":"0","SalesPrice":"950","Unit":"h","VAT":"25"},{"@url":"https://api.fortnox.se/3/articles/SRV-OLD","ArticleNumber":"SRV-OLD","Description":"Retired service (synthetic)","EAN":"","PurchasePrice":"0","QuantityInStock":"0","SalesPrice":"800","Unit":"h","VAT":"25"}],"MetaInformation":{"@CurrentPage":1,"@TotalPages":1,"@TotalResources":3}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/articles/KIT-1',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Article":{"@url":"https://api.fortnox.se/3/articles/KIT-1","ArticleNumber":"KIT-1","Description":"Workshop kit (synthetic)","Active":true,"Type":"STOCK","Unit":"st","EAN":"2000000000015","VAT":25,"PurchasePrice":120,"QuantityInStock":15,"StockGoods":true,"SalesAccount":3001,"SupplierNumber":"","Manufacturer":"Example Tools AB","ManufacturerArticleNumber":"EX-KIT-1","Note":"","SalesPrice":250}}'
      }
    }
  ]
}
