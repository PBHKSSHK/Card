# Frontend Pages Reference

## Tech Stack
- React 19 + TypeScript
- Tailwind CSS v3 + shadcn/ui
- @tanstack/react-query for data fetching
- Supabase JS client (not REST API)
- wouter for routing (hash-based: `useHashLocation`)
- lucide-react for icons
- Default to light mode

## Page Specifications

### Dashboard
**Purpose**: Overview KPIs and drill-down into unmatched items.

**Layout**: 4 stat cards on top, 2-panel collapsible sections below.

**Stat Cards**:
1. Total Transactions (count)
2. Total Amount (sum of amount_hkd)
3. Match Rate (matched / total as %)
4. Exceptions (count of status = 'exception')

**Unmatched Sections** (2 panels):
- **Unmatched CC** — transactions without matched invoice
- **Unmatched Invoices** — invoices with `is_matched = false`

Each unmatched item is expandable (click to show matched counterpart if exists).

### Upload Centre
**Purpose**: Upload PDF statements/invoices, trigger AI parsing.

**Features**:
- Drag-drop file upload zone
- Upload type selector: CC Statement / Invoice / Bank Statement / Expense Claim
- Period month picker
- Processing status indicator with progress
- Batch list showing all uploads with status
- Delete/archive batch capability
- PDF viewer for uploaded documents (via storage URL)

**Upload Flow**:
1. User drops file → upload to Supabase Storage
2. Create upload_batch record
3. Call Edge Function (parse-document)
4. Show AI-parsed results for review
5. Confirm → INSERT transactions + auto-run matching
6. Update batch status

### Recon Queue
**Purpose**: Review and run matching engine.

**Features**:
- "Auto-classify" button to run matching on all pending transactions
- Filter by status: All / Pending / Matched / Unmatched / Exception
- Transaction table with expandable rows
- Click to expand → show matched invoice details (including children)
- Manual match override (drag invoice to transaction)
- Confidence indicator per match

### Journal Export
**Purpose**: Generate ERP-format journal entries from matched data.

**Features**:
- Period selector dropdown
- Preview table grouped by credit card:
  - Card header with cardholder name + total
  - 1 CR line (credit card account)
  - N DR lines (individual transactions)
- Account mapping status (mapped/unmapped badges)
- DR/CR balance check alert
- Export button → CSV download with BOM encoding for Excel

**NetSuite CSV columns**: Entry No., Date, Account, Currency, Debit, Credit, Line: Memo, Subsidiary, Department, Name

**D365 BC General Journal columns**: Journal Template Name, Journal Batch Name, Line No., Posting Date, Document Type, Document No., Account Type, Account No., Description, Amount, Bal. Account Type, Bal. Account No.

### Settings
**Purpose**: System configuration and reference data management.

**Tabs**:
1. **Matching Rules** — CRUD for keyword → account mapping
2. **Journal** — CR account, default currency, tolerance settings
3. **Reference Data** (NetSuite/BC) — Collapsible sections for each reference table, lazy-loaded
4. **AI / API** — OpenRouter API key management

### Exceptions
**Purpose**: Handle edge cases that need manual intervention.

**Features**:
- List of exception-status transactions
- Manual match assignment
- Split transaction capability (one CC charge → multiple invoices)
- Override match type and notes

## Component Patterns

### Collapsible Data Sections
Used in Settings (reference data) and Dashboard (unmatched lists):
```tsx
<Collapsible>
  <CollapsibleTrigger>
    <ChevronRight /> Table Name <Badge>{count}</Badge>
  </CollapsibleTrigger>
  <CollapsibleContent>
    {/* Lazy-loaded table */}
  </CollapsibleContent>
</Collapsible>
```

### Supabase Query Pattern
```tsx
const { data, isLoading } = useQuery({
  queryKey: ["table-name", filters],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("table_name")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },
});
```

### Table Styling
- Headers: `text-xs font-medium text-muted-foreground`
- Body: `text-sm`
- Codes/numbers: `font-mono tabular-nums`
- Status badges: `<Badge variant="secondary|destructive|outline">`
