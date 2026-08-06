# OCR Pipeline Reference

## Architecture

```
PDF/Image Upload → Supabase Storage → Edge Function → OpenRouter (Claude Sonnet) → Structured JSON → Database INSERT
```

## Edge Function Structure

The Edge Function (`parse-document`) handles two document types:
1. **Credit Card Statements** — Extract transaction lines
2. **Vendor Invoices** — Extract invoice number, amount, line items

### Provider Detection

```typescript
function detectProvider(apiKey: string) {
  if (apiKey.startsWith('sk-or-')) {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model_text: 'anthropic/claude-sonnet-4-20250514',
      model_vision: 'anthropic/claude-sonnet-4-20250514',
    };
  }
  // fallback to OpenAI
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    model_text: 'gpt-4o',
    model_vision: 'gpt-4o',
  };
}
```

### CC Statement Prompt

Key extraction fields per transaction:
- `date`: YYYY-MM-DD
- `post_date`: posting date if different, else null
- `merchant`: clean merchant/payee name
- `amount`: charge in ORIGINAL currency (positive = charge, negative = credit/payment)
- `amount_hkd`: HKD equivalent if foreign currency AND shown on statement. null if already HKD.
- `currency`: "HKD", "USD", etc.
- `fx_rate`: exchange rate if shown (e.g. 7.82 for USD→HKD). null if HKD.
- `reference`: reference number if shown
- `card_last4`: last 4 digits
- `description`: full description including location

Metadata extraction:
- `cardholder`: cardholder name from statement header
- `statement_period`: billing period (e.g. "2026-01-01 to 2026-01-31")
- `bank`: bank name (HSBC, American Express, etc.)
- `statement_total`: total amount due

### Invoice Prompt

For invoices (Meta Ads, Google Ads, etc.):
- `invoice_number`
- `billing_period`
- `total_amount`
- `currency`
- `account_name`: advertiser/account name
- `account_id`: account ID
- `line_items[]`: individual campaign/line item details

**Critical**: Meta Ads is the ONLY exception where child line items are kept separate.
All other invoices → ONE parent line item with total amount.

### Bank Statement Prompt (for Bank Rec)

Per transaction line:
- `date`: YYYY-MM-DD
- `value_date`: value date if shown
- `description`: full description
- `debit`: debit amount (money out)
- `credit`: credit amount (money in)
- `balance`: running balance if shown
- `reference`: cheque number, wire reference, etc.

### Image/PDF Processing

1. PDF: Convert each page to base64 image using pdf-to-img or similar
2. Image: Direct base64 encoding
3. Send as `image_url` content type in the chat completion request
4. Parse JSON response from the `content` field

### Error Handling

- Retry on 429 (rate limit) with exponential backoff
- Return partial results if some pages fail
- Store raw AI response in batch notes for debugging
- Validate parsed amounts sum against statement total

## Client-Side Upload Flow

```
User drops PDF → UploadCentre.tsx
  → Upload to Supabase Storage (documents bucket)
  → Create upload_batch record (status: 'uploaded')
  → Call Edge Function with file path + upload type
  → Edge Function returns parsed transactions
  → INSERT into card_transactions / meta_invoices
  → Auto-run matching engine
  → Update batch status to 'processed'
```

## FX Handling Critical Path

When inserting card_transactions:
```typescript
const fxRate = t.fx_rate || (currency === "HKD" ? 1 : null);
const amtHkd = t.amount_hkd || (currency === "HKD" ? amount : (fxRate ? amount * fxRate : null));

// INSERT with both values
{
  amount: originalAmount,
  amount_hkd: amtHkd,
  currency: currency,
  fx_rate: fxRate || 1,
}
```
