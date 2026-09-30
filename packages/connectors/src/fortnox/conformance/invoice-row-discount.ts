import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Positional invoice-row updates on an unbooked invoice whose first row starts at Discount 5: set
 * Discount 10, omit Discount (it stays 10), send Discount 0, then restore the original rows
 * (Discount 5 again, so the restore request differs from the Discount 0 step) and verify the rows
 * and invoice totals.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages a replacement in a gitignored
 * directory; see the script header for the manual scrub-and-promote step.
 */
export const fortnoxInvoiceRowDiscountFixture: WireFixture = {
  id: 'fortnox.invoice.row-discount-sticky.synthetic',
  caseId: 'fortnox.invoice.row-discount-sticky',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://api.fortnox.se/3',
  note: 'Invoice read, three positional row updates with read-backs, then the restore update and its read-back, in request order. Synthetic placeholder shaped like the Fortnox API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1500,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1200,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":5,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":1,"Total":950,"TotalExcludingVAT":950,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":2,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1200,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1500,"TotalToPay":1500,"TotalVAT":300,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'PUT',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Invoice: {
            InvoiceRows: [
              {
                AccountNumber: 3001,
                Description: 'Consulting hours (synthetic)',
                DeliveredQuantity: '2.00',
                Unit: 'h',
                Price: 500,
                VAT: 25,
                Discount: 10,
                DiscountType: 'PERCENT'
              },
              {
                AccountNumber: 3001,
                Description: 'Travel (synthetic)',
                DeliveredQuantity: '1.00',
                Price: 250,
                VAT: 25,
                Discount: 0,
                DiscountType: 'PERCENT'
              }
            ]
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1438,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1150,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":10,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":3,"Total":900,"TotalExcludingVAT":900,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":4,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1150,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1438,"TotalToPay":1438,"TotalVAT":287.5,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1438,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1150,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":10,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":3,"Total":900,"TotalExcludingVAT":900,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":4,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1150,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1438,"TotalToPay":1438,"TotalVAT":287.5,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'PUT',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Invoice: {
            InvoiceRows: [
              {
                AccountNumber: 3001,
                Description: 'Consulting hours (synthetic)',
                DeliveredQuantity: '2.00',
                Unit: 'h',
                Price: 500,
                VAT: 25
              },
              {
                AccountNumber: 3001,
                Description: 'Travel (synthetic)',
                DeliveredQuantity: '1.00',
                Price: 250,
                VAT: 25,
                Discount: 0,
                DiscountType: 'PERCENT'
              }
            ]
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1438,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1150,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":10,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":5,"Total":900,"TotalExcludingVAT":900,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":6,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1150,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1438,"TotalToPay":1438,"TotalVAT":287.5,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1438,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1150,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":10,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":5,"Total":900,"TotalExcludingVAT":900,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":6,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1150,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1438,"TotalToPay":1438,"TotalVAT":287.5,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'PUT',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Invoice: {
            InvoiceRows: [
              {
                AccountNumber: 3001,
                Description: 'Consulting hours (synthetic)',
                DeliveredQuantity: '2.00',
                Unit: 'h',
                Price: 500,
                VAT: 25,
                Discount: 0,
                DiscountType: 'PERCENT'
              },
              {
                AccountNumber: 3001,
                Description: 'Travel (synthetic)',
                DeliveredQuantity: '1.00',
                Price: 250,
                VAT: 25,
                Discount: 0,
                DiscountType: 'PERCENT'
              }
            ]
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1563,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1250,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":7,"Total":1000,"TotalExcludingVAT":1000,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":8,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1250,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1563,"TotalToPay":1563,"TotalVAT":312.5,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1563,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1250,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":7,"Total":1000,"TotalExcludingVAT":1000,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":8,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1250,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1563,"TotalToPay":1563,"TotalVAT":312.5,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'PUT',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          Invoice: {
            InvoiceRows: [
              {
                AccountNumber: 3001,
                Description: 'Consulting hours (synthetic)',
                DeliveredQuantity: '2.00',
                Unit: 'h',
                Price: 500,
                VAT: 25,
                Discount: 5,
                DiscountType: 'PERCENT'
              },
              {
                AccountNumber: 3001,
                Description: 'Travel (synthetic)',
                DeliveredQuantity: '1.00',
                Price: 250,
                VAT: 25,
                Discount: 0,
                DiscountType: 'PERCENT'
              }
            ]
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1500,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1200,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":5,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":9,"Total":950,"TotalExcludingVAT":950,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":10,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1200,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1500,"TotalToPay":1500,"TotalVAT":300,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.fortnox.se/3/invoices/103',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"Invoice":{"@url":"https://api.fortnox.se/3/invoices/103","Balance":1500,"Booked":false,"Cancelled":false,"Comments":"","CostCenter":"","Credit":"false","Currency":"SEK","CurrencyRate":1,"CurrencyUnit":1,"CustomerName":"Example Customer AB","CustomerNumber":"1001","DocumentNumber":"103","DueDate":"2026-10-31","FinalPayDate":null,"Gross":1200,"InvoiceDate":"2026-09-30","InvoiceRows":[{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"2.00","Description":"Consulting hours (synthetic)","Discount":5,"DiscountType":"PERCENT","HouseWork":false,"Price":500,"PriceExcludingVAT":500,"Project":"","RowId":9,"Total":950,"TotalExcludingVAT":950,"Unit":"h","VAT":25,"VATCode":"MP1"},{"AccountNumber":3001,"ArticleNumber":"","ContributionPercent":"0","ContributionValue":"0","CostCenter":"","DeliveredQuantity":"1.00","Description":"Travel (synthetic)","Discount":0,"DiscountType":"PERCENT","HouseWork":false,"Price":250,"PriceExcludingVAT":250,"Project":"","RowId":10,"Total":250,"TotalExcludingVAT":250,"Unit":"","VAT":25,"VATCode":"MP1"}],"InvoiceType":"INVOICE","Net":1200,"NotCompleted":false,"OCR":"10350","OurReference":"","Project":"","Sent":false,"Total":1500,"TotalToPay":1500,"TotalVAT":300,"VoucherNumber":null,"VoucherSeries":null,"VoucherYear":null,"YourReference":""}}'
      }
    }
  ]
}
