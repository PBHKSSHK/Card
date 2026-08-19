import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Payload limits — a multi-page statement is well under these; anything bigger
// is either a mistake or someone trying to burn the OpenAI budget.
const MAX_IMAGES = 30;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024; // 40 MB of base64
const MAX_TEXT_CHARS = 200_000;

interface ParseRequest {
  type: 'cc_statement' | 'meta_invoice' | 'auto';
  text?: string;
  images?: string[];
  file_name?: string;
  api_key?: string;
}

// The function falls back to the project's OPENAI_API_KEY secret, so it must
// only ever run for a real signed-in user. The public anon key (or no token)
// is rejected: anon/service tokens have no `sub` claim so /auth/v1/user 401s.
async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    console.error('[CardRecon] SUPABASE_URL / SUPABASE_ANON_KEY not configured');
    return null;
  }

  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ?? null;
}

const CC_STATEMENT_PROMPT = `You are a financial document parser for Hong Kong credit card statements (HSBC, Hang Seng, AE/American Express, Citibank, Standard Chartered, etc.).

TASK: Extract ALL purchase/charge transactions from this credit card statement into structured JSON.

CRITICAL RULES:

1. WHAT TO EXTRACT as transactions:
   - All merchant purchase lines (e.g. "GOOGLE*ADS", "META PLATFORMS", "Amazon web services", "RIDER SHOP HK", restaurants, shops, etc.)
   - Payments received (mark as negative/credit amounts)
   - Cash rebates, credits, refunds (mark as negative/credit amounts)
   - Annual fees ("A/C ANNUAL FEE") or fee reversals ("A/C ANNUAL FEE REV")

2. WHAT NOT TO extract as transactions:
   - "PREVIOUS BALANCE" line — this is NOT a transaction, record it separately in metadata
   - "Foreign Currency Conversion" or "EXCHANGE RATE" lines (sub-details of the purchase above)
   - Statement summary sections ("TRANSACTION SUMMARY", "FEES AND CHARGES SUMMARY")
   - RewardCash summaries, spending summary tables
   - Payment advice / remittance slips, minimum payment info, fine print

3. AMOUNT HANDLING:
   - Amounts with "CR" suffix are CREDITS → record as NEGATIVE numbers
   - Amounts WITHOUT "CR" are CHARGES → record as POSITIVE numbers
   - "IFS PAYMENT - THANK YOU" with CR = payment → negative
   - If a foreign currency transaction shows an HKD equivalent, use the HKD amount
   - IMPORTANT: After extracting all transactions, compute their sum and put it in metadata.transactions_sum

4. HSBC BUSINESS CARD format:
   - Post/Trans dates in DDmon format (e.g. "02JAN", "18DEC") → convert to YYYY-MM-DD using statement year
   - "Statement balance HKDx,xxx.xx" near the top → use as total_amount
   - If statement balance has "CR" suffix, it means a credit balance → record as NEGATIVE total_amount
   - "PREVIOUS BALANCE x,xxx.xx" line → record in metadata.previous_balance
   - CRITICAL: If PREVIOUS BALANCE has "CR" suffix → record as NEGATIVE number (e.g. "25,522.66CR" → -25522.66)

5. AE/American Express format:
   - "New Balance HK$" → use as total_amount
   - "Previous Balance HK$" → use as previous_balance in metadata
   - Merchant names may be garbled in text mode — if using image mode, read from the image

6. SCANNED / HANDWRITTEN DOCUMENTS:
   - Scanned statements may have handwriting, stamps, or marks overlapping printed text
   - When reading amounts, ignore any handwritten marks and read ONLY the printed numbers
   - If an amount looks unusually small for a merchant (e.g. 150 for a company that typically charges thousands), double-check by looking at the digit alignment in the Amount column — there may be leading digits (like "3,") obscured by handwriting
   - The Amount column is RIGHT-ALIGNED — use the position of digits relative to other rows to verify

7. SELF-CHECK (mandatory):
   - After extraction, compute: previous_balance + transactions_sum and compare to total_amount
   - If the difference is > $1, you MUST re-examine EVERY transaction amount by carefully re-reading each amount from the image
   - Common OCR errors on scanned docs: missing leading digits (e.g. "3,450.00" misread as "450.00" or "150.00"), comma vs period confusion
   - Fix any discrepancies before returning the final JSON

For each transaction extract:
- date: YYYY-MM-DD
- post_date: YYYY-MM-DD if different, else null
- merchant: merchant/payee name (clean, readable)
- amount: positive for charges, negative for credits/payments
- currency: currency code (default "HKD")
- reference: reference number if shown
- card_last4: last 4 digits of card number
- description: full description including location

Return JSON:
{
  "transactions": [...],
  "metadata": {
    "statement_period": "YYYY-MM to YYYY-MM",
    "card_last4": "XXXX",
    "total_amount": <statement balance as number, negative if CR>,
    "previous_balance": <previous balance as number; NEGATIVE if CR suffix; 0 if not shown>,
    "transactions_sum": <sum of all transaction amounts you extracted>,
    "bank": "HSBC" | "American Express" | etc.,
    "cardholder": "name",
    "account_number": "full account number if shown"
  }
}

CRITICAL: Return ONLY valid JSON. No markdown, no code fences, no explanation. Parse EVERY transaction.`;

const META_INVOICE_PROMPT = `You are a financial document parser for invoices, billing statements, and shopping receipts.

TASK: Extract invoice data into structured JSON.

═══════════════════════════════════════════════════
CORE RULES:
═══════════════════════════════════════════════════

For ALL documents (including Meta):
- Always create ONE "parent" invoice with the document TOTAL amount
- The parent invoice goes in the "invoices" array
- For Meta/Facebook Ads ONLY: also return campaign line items in a separate "children" array
- For all other documents: "children" array is empty []

═══════════════════════════════════════════════════
FIELD DEFINITIONS (every line item MUST have ALL fields):
═══════════════════════════════════════════════════

- invoice_number: (string) The receipt/invoice/order number from the document header.
- description: (string) REQUIRED. A concise summary. Format: "[Vendor] Summary".
  Examples:
  • "[Uber] Taxi - Wan Chai to Mong Kok, 7.8km. Fare $109.68 + Booking $16 + Tunnel $40"
  • "[GoGoX] 廂型貨車 - 旺角→西貢, 基本$145 + 平台費$5 + 貼士$50"
  • "[CUIT] Catering order: sandwiches, scones, coffee x10, olive oil, balsamic vinegar etc. (25 items)"
  • "[Adobe] Creative Cloud Pro x12 seats, Nov-Dec 2025"
  • "[Meta] OCBC-SSHK Ad account, 10 campaigns incl. IG Page Like, FB Traffic, Tesla車貸"
  NEVER leave description empty or null.
- amount: (number) The TOTAL amount of the entire document.
- currency: (string) Currency code. Default "HKD". Use "USD" if the document shows US dollars.
- invoice_date: (string) Date in YYYY-MM-DD format.
- billing_period: (string|null) Service period if shown, else null.
- account_name: (string) The VENDOR/SELLER name, NOT the buyer.
- account_id: (string|null) Account/customer/order ID if shown, else null.

═══════════════════════════════════════════════════
PAYMENT / BANK DETAILS (remittance instructions):
═══════════════════════════════════════════════════
Many invoices print the VENDOR's own receiving/payment instructions — how the
buyer should pay them. Look for sections like "Payment Details", "Payment
Method", "Bank Details", "Remittance", "付款方法", "銀行資料", "過數", "轉數快", "FPS".

Extract into metadata.payment_info (use null for any field not shown):
- bank_name: (string|null) bank name, e.g. "HSBC", "Hang Seng Bank", "中國銀行(香港)"
- bank_account_number: (string|null) account number AS PRINTED (keep hyphens/spaces)
- account_name: (string|null) beneficiary / account holder name (who to pay)
- fps_id: (string|null) FPS 轉數快 ID (phone number / email / FPS ID) if shown
- payment_method: "bank_transfer" if a bank account is shown; "fps" if only FPS
  is shown; "cheque" if only a cheque payee is given; else null

CRITICAL: these are the VENDOR's receiving details printed on the document.
Do NOT invent values. Do NOT use the buyer's details. If the document shows no
payment instructions at all, set metadata.payment_info = null.

═══════════════════════════════════════════════════
SPECIAL CASE — META / FACEBOOK ADS ONLY:
═══════════════════════════════════════════════════
For Meta/Facebook Ads receipts:
1. "invoices" array: ONE parent item with the TOTAL invoice amount.
   - description: "[Meta] Ad account name, N campaigns, billing period"
   - amount: the grand total of the entire invoice
2. "children" array: each campaign line item (CHILD lines, indented in the receipt).
   - PARENT lines (bold) = campaign subtotals → DO NOT extract (double-count risk)
   - CHILD lines (indented) = individual ad breakdowns → EXTRACT these
   - Each child has same fields as invoice: invoice_number, description, amount, currency, invoice_date, billing_period, account_name, account_id
   - description: "[Meta] Campaign name - ad details"
   - account_name = the ad account name from header (e.g. "OCBC - SSHK Ad")
   - account_id = 帳戶編號

All other document types: "children" is empty [].

═══════════════════════════════════════════════════
SELF-CHECK (mandatory):
═══════════════════════════════════════════════════
- invoices array must have exactly 1 item, and its amount must = metadata.total_amount
- For Meta: sum of children must ≈ metadata.total_amount
- Verify description is non-empty and starts with [Vendor]
- Verify account_name is the VENDOR, not the buyer

Return JSON:
{
  "invoices": [
    {
      "invoice_number": "FBADS-511-10527110",
      "description": "[Meta] OCBC-SSHK Ad account, 15 campaigns, Dec 2025",
      "amount": 7027.00,
      "currency": "HKD",
      "invoice_date": "2025-12-31",
      "billing_period": "2025-12-01 to 2025-12-31",
      "account_name": "Meta",
      "account_id": "511-10527110"
    }
  ],
  "children": [
    {
      "invoice_number": "FBADS-511-10527110",
      "description": "[Meta] AWE #亞博SHO... - IG engagement",
      "amount": 799.26,
      "currency": "HKD",
      "invoice_date": "2025-12-31",
      "billing_period": "2025-12-01 to 2025-12-31",
      "account_name": "OCBC - SSHK Ad",
      "account_id": "511-10527110"
    }
  ],
  "metadata": {
    "vendor": "Meta",
    "total_amount": 7027.00,
    "account_name": "Meta",
    "account_id": "511-10527110",
    "receipt_number": "FBADS-511-10527110",
    "payment_info": null
  }
}

For non-Meta example:
{
  "invoices": [
    {
      "invoice_number": "P2510001293",
      "description": "[Uber] Taxi - Wan Chai to Mong Kok, 7.8km. Fare $109.68 + Booking $16 + Tunnel $40",
      "amount": 165.68,
      "currency": "HKD",
      "invoice_date": "2025-11-12",
      "billing_period": null,
      "account_name": "Uber",
      "account_id": null
    }
  ],
  "children": [],
  "metadata": {
    "vendor": "Uber",
    "total_amount": 165.68,
    "account_name": "Uber",
    "account_id": null,
    "receipt_number": "P2510001293",
    "payment_info": {
      "bank_name": "HSBC",
      "bank_account_number": "004-567890-838",
      "account_name": "ABC Production Limited",
      "fps_id": null,
      "payment_method": "bank_transfer"
    }
  }
}
(payment_info here is only an example — extract it from the document's own
remittance section; null when the document shows none.)

CRITICAL: Return ONLY valid JSON. No markdown, no code fences, no explanation.`;

const AUTO_CLASSIFY_PROMPT = `Look at this document and determine what type it is. Reply with ONLY one word:

- "cc_statement" if it is a BANK CREDIT CARD MONTHLY STATEMENT (issued by a BANK like HSBC, American Express, Citibank, Hang Seng, Standard Chartered, etc.). These contain MANY transactions from different merchants over a billing period, with a statement balance, previous balance, payment due date, etc.

- "meta_invoice" for EVERYTHING ELSE — any individual invoice, receipt, order confirmation, billing statement from a specific vendor (Uber, GoGoX, Meta/Facebook, Google Ads, Amazon, Adobe, Microsoft, HKTVmall, restaurants, shops, catering companies, any single merchant). Even if it has multiple line items, if it's from ONE vendor/merchant, it is "meta_invoice".

KEY DISTINCTION: A credit card statement lists transactions from MANY DIFFERENT merchants. An invoice/receipt is from ONE specific merchant/vendor.

Reply with ONLY the word "cc_statement" or "meta_invoice". Nothing else.`;

function detectProvider(apiKey: string): { url: string; model_text: string; model_vision: string; supportsJsonMode: boolean } {
  if (apiKey.startsWith('sk-or-')) {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model_text: 'anthropic/claude-sonnet-4-6',
      model_vision: 'anthropic/claude-sonnet-4-6',
      supportsJsonMode: false,
    };
  }
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    model_text: 'gpt-4o',
    model_vision: 'gpt-4o',
    supportsJsonMode: true,
  };
}

async function classifyDocument(
  provider: { url: string; model_text: string; model_vision: string; supportsJsonMode: boolean },
  resolvedKey: string,
  text?: string,
  images?: string[],
  file_name?: string
): Promise<'cc_statement' | 'meta_invoice'> {
  const useVision = images && images.length > 0;
  const messages: any[] = [
    { role: 'system', content: AUTO_CLASSIFY_PROMPT },
  ];

  if (useVision && images) {
    const content: any[] = [
      { type: 'text', text: `Classify this document. File: ${file_name || 'unknown'}` },
    ];
    // Only send first image/page for classification (save tokens)
    content.push({
      type: 'image_url',
      image_url: {
        url: images[0].startsWith('data:') ? images[0] : `data:image/jpeg;base64,${images[0]}`,
        detail: 'low',
      },
    });
    messages.push({ role: 'user', content });
  } else if (text) {
    // Send first 2000 chars for classification
    messages.push({
      role: 'user',
      content: `Classify this document. File: ${file_name || 'unknown'}.\n\n${text.substring(0, 2000)}`,
    });
  }

  const model = useVision ? provider.model_vision : provider.model_text;

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resolvedKey}`,
      'Content-Type': 'application/json',
      ...(resolvedKey.startsWith('sk-or-') ? { 'HTTP-Referer': 'https://cardrecon.vercel.app', 'X-Title': 'CardRecon' } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: 20,
    }),
  });

  if (!response.ok) {
    console.error(`[CardRecon] Classification API error: ${response.status}`);
    return 'meta_invoice'; // Default to invoice if classification fails
  }

  const result = await response.json();
  const content = (result.choices?.[0]?.message?.content || '').trim().toLowerCase();
  console.log(`[CardRecon] Auto-classified "${file_name}" as: ${content}`);

  if (content.includes('cc_statement')) return 'cc_statement';
  return 'meta_invoice';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const userId = await getAuthenticatedUserId(req);
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: sign in to parse documents.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: ParseRequest = await req.json();
    let { type, text, images, file_name, api_key } = body;

    let resolvedKey = api_key
      || req.headers.get('x-api-key')
      || Deno.env.get('OPENAI_API_KEY');

    // Fall back to the AI key stored in Supabase Vault (get_ai_api_key RPC,
    // service_role only) so the whole team can parse without each person
    // configuring a key in Settings.
    if (!resolvedKey) {
      try {
        const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        const { data } = await svc.rpc('get_ai_api_key');
        if (data) resolvedKey = data as string;
      } catch (e) {
        console.error('[CardRecon] Vault key lookup failed:', e);
      }
    }

    if (!resolvedKey) {
      return new Response(
        JSON.stringify({ error: 'No API key provided. Set it in Settings or configure OPENAI_API_KEY secret.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!type || (!text && (!images || images.length === 0))) {
      return new Response(
        JSON.stringify({ error: 'Must provide type and either text or images' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (images && images.length > MAX_IMAGES) {
      return new Response(
        JSON.stringify({ error: `Too many pages (${images.length}). Maximum is ${MAX_IMAGES}.` }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (images && images.reduce((s, img) => s + img.length, 0) > MAX_TOTAL_IMAGE_BYTES) {
      return new Response(
        JSON.stringify({ error: 'Image payload too large. Reduce page count or resolution.' }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (text && text.length > MAX_TEXT_CHARS) {
      return new Response(
        JSON.stringify({ error: 'Text payload too large.' }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[CardRecon] Parse request from user ${userId}: file="${file_name}", type=${type}, images=${images?.length || 0}`);

    const provider = detectProvider(resolvedKey);

    // Auto-classify if type is "auto"
    if (type === 'auto') {
      type = await classifyDocument(provider, resolvedKey, text, images, file_name);
      console.log(`[CardRecon] File "${file_name}" auto-detected as: ${type}`);
    }

    const useVision = images && images.length > 0;
    const systemPrompt = type === 'cc_statement' ? CC_STATEMENT_PROMPT : META_INVOICE_PROMPT;

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    if (useVision && images) {
      const content: any[] = [
        { type: 'text', text: `Parse this ${type === 'cc_statement' ? 'credit card statement' : 'invoice'}. File: ${file_name || 'unknown'}. Extract ALL transactions — do not skip any. Pay close attention to every merchant line and amount. This may be a scanned document with handwritten marks — ignore handwriting and read ONLY the printed numbers. After extracting, do the self-check: previous_balance + transactions_sum must equal total_amount. If not, re-read every amount carefully.` },
      ];
      for (const img of images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`,
            detail: 'high',
          },
        });
      }
      messages.push({ role: 'user', content });
    } else if (text) {
      messages.push({
        role: 'user',
        content: `Parse this ${type === 'cc_statement' ? 'credit card statement' : 'invoice'}. File: ${file_name || 'unknown'}.\n\nExtract ALL merchant/purchase transactions. Do NOT include PREVIOUS BALANCE or summary sections as transactions. Use the "Statement balance" (not spending summary) as total_amount.\n\n${text}`,
      });
    }

    const model = useVision ? provider.model_vision : provider.model_text;

    const response = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resolvedKey}`,
        'Content-Type': 'application/json',
        ...(resolvedKey.startsWith('sk-or-') ? { 'HTTP-Referer': 'https://cardrecon.vercel.app', 'X-Title': 'CardRecon' } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 8192,
        ...(provider.supportsJsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[CardRecon] AI API error (${response.status}): ${errText.substring(0, 1000)}`);
      return new Response(
        JSON.stringify({ error: `AI API error (${response.status}). Check the function logs for details.` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
      return new Response(
        JSON.stringify({ error: 'No response from AI model' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let parsed;
    try {
      // Try parsing directly first
      let cleanContent = content.trim();
      // Strategy 1: Strip leading/trailing markdown fences
      if (cleanContent.startsWith('```')) {
        cleanContent = cleanContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      try {
        parsed = JSON.parse(cleanContent);
      } catch {
        // Strategy 2: Extract JSON from code fence inside reasoning text
        const fenceMatch = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (fenceMatch) {
          parsed = JSON.parse(fenceMatch[1]);
        } else {
          // Strategy 3: Find first { to last } (brace matching)
          const start = content.indexOf('{');
          const end = content.lastIndexOf('}');
          if (start >= 0 && end > start) {
            parsed = JSON.parse(content.substring(start, end + 1));
          } else {
            throw new Error('No JSON found in response');
          }
        }
      }
    } catch (parseErr: any) {
      console.error(`[CardRecon] Failed to parse AI response as JSON: ${parseErr.message}. Raw: ${String(content).substring(0, 500)}`);
      return new Response(
        JSON.stringify({ error: `Failed to parse AI response as JSON: ${parseErr.message}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Normalize: if metadata is nested, lift it up for the frontend
    const metadata = parsed.metadata || {};
    const finalData: any = { ...parsed };
    if (!finalData.statement_period && metadata.statement_period) finalData.statement_period = metadata.statement_period;
    if (!finalData.card_last4 && metadata.card_last4) finalData.card_last4 = metadata.card_last4;
    if (finalData.total_amount == null && metadata.total_amount != null) finalData.total_amount = metadata.total_amount;
    if (!finalData.bank && metadata.bank) finalData.bank = metadata.bank;
    if (finalData.previous_balance == null && metadata.previous_balance != null) finalData.previous_balance = metadata.previous_balance;
    if (finalData.transactions_sum == null && metadata.transactions_sum != null) finalData.transactions_sum = metadata.transactions_sum;

    // Auto-correct sign of previous_balance if it makes the formula work better
    // Formula: previous_balance + transactions_sum ≈ total_amount
    if (type === 'cc_statement') {
      const prev = finalData.previous_balance ?? finalData.metadata?.previous_balance ?? 0;
      const txnSum = finalData.transactions_sum ?? finalData.metadata?.transactions_sum;
      const total = finalData.total_amount ?? finalData.metadata?.total_amount;
      if (typeof prev === 'number' && prev !== 0 && typeof txnSum === 'number' && typeof total === 'number') {
        const diffOrig = Math.abs(total - (prev + txnSum));
        const diffFlip = Math.abs(total - (-prev + txnSum));
        if (diffFlip < diffOrig && diffFlip < 1.0) {
          console.log(`[CardRecon] Auto-correcting previous_balance sign: ${prev} → ${-prev}`);
          finalData.previous_balance = -prev;
          if (finalData.metadata) finalData.metadata.previous_balance = -prev;
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        type,
        file_name: file_name || 'unknown',
        data: finalData,
        model,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
