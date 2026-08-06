# Matching Engine Reference

## Algorithm

Client-side matching engine (runs in browser). 4-stage waterfall:

### Stage 1: Exact Match
- Amount difference < $0.01
- Same currency
- Same date (0 days difference)
- Confidence: 100%

### Stage 2: Near Date Match
- Amount difference < $0.01
- Same currency
- Date within `date_tolerance_days` (default 5)
- Confidence: max(70, 100 - days × 6)

### Stage 3: Fuzzy Match
- Amount within `amount_tolerance_pct` (default 5%)
- Levenshtein similarity between merchant and invoice account_name/description
- Similarity >= `fuzzy_threshold` (default 0.60)
- Takes best match if multiple qualify
- Confidence: similarity × 100

### Stage 4: Rule Match (no invoice)
- Merchant matches a keyword pattern in matching_rules
- No invoice linked — just assigns entity/department/account
- Confidence: 85%

### Stage 5: Unmatched
- Falls through all stages
- Confidence: 0%

## Helper Functions

### Wildcard Match
```typescript
function wildcardMatch(pattern: string, text: string): boolean {
  const p = pattern.toUpperCase().replace(/\*/g, '');
  return text.toUpperCase().includes(p);
}
```

### Levenshtein Similarity
Returns 0-1 score. Used for fuzzy merchant name matching.

### Days Between
Absolute day difference between two dates.

## Matching Rules

Rules are sorted by `priority` (ascending = higher priority). Each rule has:
- `keyword`: pattern to match against merchant name
- `dr_account_code`: debit account for the expense
- `cr_account_code`: credit account (usually the CC liability account)
- `target_entity`: entity/company code
- `dept_code`: department code
- Intercompany fields: `is_intercompany`, `intercompany_account`, `subsidiary_name`

## Critical: Sync is_matched

When the matching engine produces `status = 'matched'`:
1. UPDATE reconciliation_results with match details
2. **IMMEDIATELY** UPDATE meta_invoices SET is_matched = true WHERE id = invoiceId
3. Do NOT gate `is_matched` behind entity/department resolution

```typescript
// CORRECT — always sync is_matched
if (result.status === 'matched' && result.invoiceId) {
  await supabase
    .from("meta_invoices")
    .update({ is_matched: true })
    .eq("id", result.invoiceId);
}

// entity/department accounting is separate
if (result.status === 'matched' && result.entityId && result.departmentId) {
  // ... create accounting_lines
}
```

## Bank Rec Matching (adaptation)

For bank reconciliation, the matching logic changes:
- **Source**: bank_transactions (from bank statement)
- **Target**: GL entries from ERP (e.g. Bank Account Ledger Entries in D365 BC)
- **Match criteria**: Amount + date + reference number
- **Additional**: Cheque numbers, wire transfer references, direct debit mandates
- **Outstanding items**: Transactions in bank but not GL (timing differences)
