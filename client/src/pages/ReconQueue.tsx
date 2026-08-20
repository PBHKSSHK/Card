import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePagination, PaginationFooter } from "@/components/PaginationFooter";
import { StatusBadge, formatCurrency } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { runMatchingEngine } from "@/lib/matching-engine";
import { useNoLedgerEntities } from "@/hooks/use-no-ledger-entities";
import { Play, Search, Filter, Loader2, Calendar, CreditCard, CheckCircle2, AlertCircle, Trash2, FileText, ExternalLink, ChevronDown, ChevronRight, Plus, X, Split as SplitIcon, Unlink, Link2 } from "lucide-react";
import AssignModal from "@/components/AssignModal";
import SplitModal from "@/components/SplitModal";
import type { TransactionFull, MatchStatus, MetaInvoice, MetaInvoiceSplit, NsProjectCode, ExpenseCategory } from "@shared/schema";
import { projectMatchesEntity } from "@shared/schema";
import { formatCategoryLabel } from "@/lib/utils";

/** Display invoice amount — shows HKD equivalent for foreign currency with original as tooltip */
function InvAmount({ inv }: { inv: MetaInvoice }) {
  if (inv.currency && inv.currency !== 'HKD') {
    const hkd = inv.amount_hkd ?? inv.amount;
    return (
      <span
        title={`Original: ${inv.currency} ${Number(inv.amount).toLocaleString('en-HK', { minimumFractionDigits: 2 })}, Rate: ${inv.fx_rate || '~7.8'}`}
        className="bg-yellow-100 dark:bg-yellow-900/40 px-1 rounded whitespace-nowrap"
      >
        {formatCurrency(hkd, 'HKD')}
        <span className="text-[9px] text-muted-foreground ml-0.5">({inv.currency})</span>
      </span>
    );
  }
  return <span className="whitespace-nowrap">{formatCurrency(inv.amount, inv.currency)}</span>;
}

/** Get HKD amount for an invoice (for totals) */
function invHkd(inv: MetaInvoice): number {
  return Number(inv.amount_hkd) || Number(inv.amount) || 0;
}

const ENTITY_OPTIONS = ["SSHK", "PBHK", "JM", "CLS", "704", "EXT", "JS"];

/** Compact inline editor for a CHILD invoice row — Charge To / Project / Expense Category selects. */
function ChildInvoiceFields({
  child,
  projectCodes,
  expenseCategories,
  accountsByEntity,
  nsDepartments: _nsDepartments,
  onUpdate,
}: {
  child: MetaInvoice;
  projectCodes: NsProjectCode[];
  expenseCategories: ExpenseCategory[];
  accountsByEntity?: Map<string, Set<string>>;
  // 保留 prop signature 以兑源 InvoiceSplitEditor caller 樣；Child row 未隨路從有 dept picker
  nsDepartments?: { entity_code: string; charge_to: string; name: string; subsidiary_name: string }[];
  onUpdate: (patch: Partial<MetaInvoice>) => void;
}) {
  // Build chargeTo grouped options from nsDepartments
  const childChargeToByEntity = useMemo(() => {
    const m = new Map<string, { charge_to: string; name: string }[]>();
    for (const d of (_nsDepartments || [])) {
      if (!d.entity_code || !d.charge_to) continue;
      if (!m.has(d.entity_code)) m.set(d.entity_code, []);
      m.get(d.entity_code)!.push({ charge_to: d.charge_to, name: d.name });
    }
    return m;
  }, [_nsDepartments]);

  // Filter projects by entity. If filter yields empty (e.g. EXT/JS not yet in NetSuite),
  // fall back to showing ALL projects so the user can still pick one manually.
  const matchedProjects = projectCodes.filter(p => projectMatchesEntity(p, child.charge_to_entity || null));
  const filteredProjects = matchedProjects.length > 0 ? matchedProjects : projectCodes;
  const allowed = child.charge_to_entity ? accountsByEntity?.get(child.charge_to_entity) : undefined;
  // If entity is set but has no matching accounts (empty Set), fall back to showing all
  // categories so the user is never stuck with an empty dropdown.
  const entityMatched = allowed ? expenseCategories.filter(c => allowed.has(c.ns_account_number)) : [];
  const filteredCategories = allowed && entityMatched.length > 0 ? entityMatched : expenseCategories;
  // JS / Go Asia — no independent NetSuite ledger, Category doesn't apply.
  const noLedgerEntities = useNoLedgerEntities();
  const isNoLedger = !!child.charge_to_entity && noLedgerEntities.has(child.charge_to_entity);
  // Stop row-level click bubbling for the whole cell so Radix Select's portal close doesn't trigger a parent row toggle.
  const stop = (e: React.MouseEvent | React.PointerEvent) => e.stopPropagation();
  return (
    <>
      <td className="px-1 py-0.5" onClick={stop} onPointerDown={stop}>
        <Select
          value={child.charge_to_code || "__none__"}
          onValueChange={(v) => {
            const newCode = v === "__none__" ? null : v;
            const dept = newCode ? (_nsDepartments || []).find(d => d.charge_to === newCode) : null;
            const newEntity = dept?.entity_code || null;
            const curProj = projectCodes.find(p => p.project_id === child.project_code);
            const keepProj = !child.project_code || !curProj || projectMatchesEntity(curProj, newEntity);
            const patch: Partial<MetaInvoice> = { charge_to_code: newCode, charge_to_entity: newEntity };
            if (!keepProj) patch.project_code = null;
            onUpdate(patch);
          }}
        >
          <SelectTrigger className="h-6 text-[10px] px-1.5 min-w-[140px]"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="__none__">—</SelectItem>
            {Array.from(childChargeToByEntity.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([entity, items]) => (
                <div key={entity}>
                  <div className="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground sticky top-0 bg-popover">{entity}</div>
                  {items.map(d => (
                    <SelectItem key={d.charge_to} value={d.charge_to}>
                      <span className="font-mono text-[10px]">{d.charge_to}</span>
                      <span className="text-muted-foreground ml-1">— {d.name}</span>
                    </SelectItem>
                  ))}
                </div>
              ))}
          </SelectContent>
        </Select>
      </td>
      <td className="px-1 py-0.5" onClick={stop} onPointerDown={stop}>
        <Select
          value={child.project_code || "__none__"}
          onValueChange={(v) => onUpdate({ project_code: v === "__none__" ? null : v })}
        >
          <SelectTrigger className="h-6 text-[10px] px-1.5 min-w-[70px]"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="__none__">—</SelectItem>
            {filteredProjects.map(p => <SelectItem key={p.id} value={p.project_id}>{p.project_id} · {p.project_name}</SelectItem>)}
          </SelectContent>
        </Select>
      </td>
      <td className="px-1 py-0.5" onClick={stop} onPointerDown={stop}>
        {isNoLedger ? (
          <span className="inline-flex h-6 items-center rounded border border-border/50 bg-muted/40 px-1.5 text-[9px] text-muted-foreground whitespace-nowrap"
            title={`${child.charge_to_entity} 喺 NetSuite 冇獨立 ledger — 唔使揀 Category（只出 Due From AR）`}>
            唔使 — Due From
          </span>
        ) : (
        <Select
          value={child.expense_category || "__none__"}
          onValueChange={(v) => {
            if (v === "__none__") {
              onUpdate({ expense_category: null, ns_account_number: null, ns_account_name: null });
            } else {
              const cat = expenseCategories.find(c => c.category_key === v);
              onUpdate({ expense_category: v, ns_account_number: cat?.ns_account_number || null, ns_account_name: cat?.label_en || null });
            }
          }}
        >
          <SelectTrigger className="h-6 text-[10px] px-1.5 min-w-[90px]"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="__none__">—</SelectItem>
            {filteredCategories.length === 0 && child.charge_to_entity && (
              <div className="px-2 py-1.5 text-[10px] text-muted-foreground">{child.charge_to_entity} 冇對應科目</div>
            )}
            {filteredCategories.map(c => <SelectItem key={c.id} value={c.category_key}>{formatCategoryLabel(c.label_zh, c.ns_account_number)} · {c.ns_account_number}</SelectItem>)}
          </SelectContent>
        </Select>
        )}
      </td>
      {/* 備註 — Upload Centre 每一筆嘅備註，喺度直接睇 + 改（journal line memo 用佢） */}
      <td className="px-1 py-0.5" onClick={stop} onPointerDown={stop}>
        <Input
          key={`${child.id}-note-${child.notes ?? ""}`}
          type="text"
          className="h-6 text-[10px] px-1.5 min-w-[110px]"
          defaultValue={child.notes || ""}
          placeholder="備註"
          title={child.notes || "備註（journal line memo 用）"}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v !== (child.notes || "")) onUpdate({ notes: v || null });
          }}
        />
      </td>
    </>
  );
}

/** Inline editor for invoice-level splits (multiple projects per invoice). Spans full table width. */
function InvoiceSplitEditor({
  inv,
  splits,
  projectCodes,
  expenseCategories,
  accountsByEntity,
  nsDepartments = [],
  colSpan,
  onAddSplit,
  onUpdateSplit,
  onDeleteSplit,
  onUpdateInvoice,
}: {
  inv: MetaInvoice;
  splits: MetaInvoiceSplit[];
  projectCodes: NsProjectCode[];
  expenseCategories: ExpenseCategory[];
  accountsByEntity?: Map<string, Set<string>>;
  nsDepartments?: { entity_code: string; charge_to: string; name: string; subsidiary_name: string }[];
  colSpan: number;
  onAddSplit: (projectCode: string | null, amount: number) => void;
  onUpdateSplit: (id: string, patch: Partial<Pick<MetaInvoiceSplit, 'project_code' | 'amount_hkd' | 'note'>>) => void;
  onDeleteSplit: (id: string) => void;
  onUpdateInvoice: (patch: Partial<MetaInvoice>) => void;
}) {
  // 可揀 charge_to options (依 entity_code 分組)
  const chargeToByEntity = useMemo(() => {
    const m = new Map<string, { charge_to: string; name: string }[]>();
    for (const d of nsDepartments) {
      if (!m.has(d.entity_code)) m.set(d.entity_code, []);
      m.get(d.entity_code)!.push({ charge_to: d.charge_to, name: d.name });
    }
    return m;
  }, [nsDepartments]);
  const entityList = useMemo(() => {
    const seen = new Set<string>();
    const out: { code: string; subsidiary: string }[] = [];
    for (const d of nsDepartments) {
      if (seen.has(d.entity_code)) continue;
      seen.add(d.entity_code);
      out.push({ code: d.entity_code, subsidiary: d.subsidiary_name });
    }
    return out;
  }, [nsDepartments]);
  const invTotal = invHkd(inv);
  const splitTotal = splits.reduce((s, sp) => s + Number(sp.amount_hkd || 0), 0);
  const diff = Math.round((invTotal - splitTotal) * 100) / 100;
  const balanced = Math.abs(diff) < 0.01;

  // Filter project codes by charge_to_entity (uses SS/PB- prefix mapping)
  // Fallback: if entity has no matching projects in NetSuite (e.g. EXT/JS), show all.
  const matchedProjs = projectCodes.filter(p => projectMatchesEntity(p, inv.charge_to_entity || null));
  const filteredProjects = matchedProjs.length > 0 ? matchedProjs : projectCodes;
  const allowedAccts = inv.charge_to_entity ? accountsByEntity?.get(inv.charge_to_entity) : undefined;
  // Fallback to showing all categories if filter yields empty set
  const entityMatched = allowedAccts ? expenseCategories.filter(c => allowedAccts.has(c.ns_account_number)) : [];
  const filteredCategories = allowedAccts && entityMatched.length > 0 ? entityMatched : expenseCategories;
  // JS / Go Asia — no independent NetSuite ledger, Category doesn't apply.
  const noLedgerEntities = useNoLedgerEntities();

  return (
    <tr className="bg-muted/20 border-b border-border/50">
      <td colSpan={colSpan} className="px-4 py-3">
        <div className="space-y-2">
          {/* Journal-precedence hint. The journal reads the transaction's accounting_lines
              FIRST and only falls back to these invoice fields when that txn has NO
              accounting_lines. So editing here does NOT reach the journal for an
              already-matched/assigned txn — that must be done via the txn's Actions →
              Assign / Split (which rewrite accounting_lines). */}
          <div className={`rounded-md px-2 py-1.5 text-[10px] leading-snug border ${
            inv.is_matched
              ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300/60 text-amber-800 dark:text-amber-300'
              : 'bg-muted/40 border-border/50 text-muted-foreground'
          }`}>
            {inv.is_matched
              ? '⚠️ 此 invoice 已配對交易。喺度改 Charge To / Project / Account 未必會入 journal（journal 以該交易嘅 accounting_lines 為準）。要改到 journal，請用該交易右邊 Actions → Assign / Split，改完再重新 Export CSV。'
              : '💡 呢度嘅改動只會經「invoice fallback」入 journal（僅當該交易未有 accounting_lines 時生效）。已配對／已 assign 嘅交易請改用該交易右邊 Actions → Assign / Split。'}
          </div>
          {/* Inline edit row: admin can fix OCR mistakes here */}
          <div className="flex items-center gap-2 flex-wrap text-[11px] pb-2 border-b border-border/40">
            <span className="font-medium text-muted-foreground">修改欄位：</span>
            <label className="text-[10px] text-muted-foreground">Invoice #</label>
            <Input
              type="text"
              className="h-7 text-[11px] w-[160px] font-medium"
              defaultValue={inv.invoice_number || ""}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v !== (inv.invoice_number || "")) onUpdateInvoice({ invoice_number: v || null });
              }}
              placeholder="Invoice #"
            />
            <label className="text-[10px] text-muted-foreground">Date</label>
            <Input
              type="date"
              className="h-7 text-[11px] w-[140px] tabular-nums"
              defaultValue={inv.invoice_date || ""}
              onBlur={(e) => {
                const v = e.currentTarget.value;
                if (v !== (inv.invoice_date || "")) onUpdateInvoice({ invoice_date: v || null });
              }}
            />
            <label className="text-[10px] text-muted-foreground">Amount</label>
            <Input
              type="number"
              step="0.01"
              className="h-7 text-[11px] w-[110px] tabular-nums text-right"
              defaultValue={Number(inv.amount || 0).toFixed(2)}
              onBlur={(e) => {
                const v = parseFloat(e.currentTarget.value);
                if (!isNaN(v) && v !== Number(inv.amount || 0)) onUpdateInvoice({ amount: v });
              }}
            />
            <Input
              type="text"
              maxLength={3}
              className="h-7 text-[11px] w-[60px] uppercase"
              defaultValue={inv.currency || "HKD"}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim().toUpperCase();
                if (v && v !== (inv.currency || "HKD")) onUpdateInvoice({ currency: v });
              }}
            />
            <label className="text-[10px] text-muted-foreground ml-2">Description</label>
            <Input
              type="text"
              className="h-7 text-[11px] flex-1 min-w-[200px]"
              defaultValue={inv.description || ""}
              onBlur={(e) => {
                const v = e.currentTarget.value;
                if (v !== (inv.description || "")) onUpdateInvoice({ description: v || null });
              }}
              placeholder="Description"
            />
          </div>

          {/* Header row: invoice-level charge-to, project & account */}
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="font-medium text-muted-foreground">Charge To:</span>
            <Select
              value={inv.charge_to_code || "__none__"}
              onValueChange={(v) => {
                const newCode = v === "__none__" ? null : v;
                // Auto-derive entity from charge_to_code via ns_departments
                const dept = newCode ? nsDepartments.find(d => d.charge_to === newCode) : null;
                const newEntity = dept?.entity_code || null;
                // If current project no longer matches the derived entity, clear it.
                const currentProj = projectCodes.find(p => p.project_id === inv.project_code);
                const currentProjectValid = !inv.project_code || !currentProj || projectMatchesEntity(currentProj, newEntity);
                const patch: Partial<MetaInvoice> = {
                  charge_to_code: newCode,
                  charge_to_entity: newEntity,
                };
                if (!currentProjectValid) patch.project_code = null;
                onUpdateInvoice(patch);
              }}
            >
              <SelectTrigger className="h-7 text-[11px] w-[260px]">
                <SelectValue placeholder="揀 Charge To" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                <SelectItem value="__none__">— (unset)</SelectItem>
                {Array.from(chargeToByEntity.entries())
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([entity, items]) => (
                    <div key={entity}>
                      <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0 bg-popover">
                        {entity}
                      </div>
                      {items.map(d => (
                        <SelectItem key={d.charge_to} value={d.charge_to}>
                          <span className="font-mono text-[11px]">{d.charge_to}</span>
                          <span className="text-muted-foreground ml-2">— {d.name}</span>
                        </SelectItem>
                      ))}
                    </div>
                  ))}
              </SelectContent>
            </Select>
            <span className="font-medium text-muted-foreground ml-3">Invoice Project:</span>
            <Select
              value={inv.project_code || "__none__"}
              onValueChange={(v) => onUpdateInvoice({ project_code: v === "__none__" ? null : v })}
            >
              <SelectTrigger className="h-7 text-[11px] w-[220px]">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— (no project)</SelectItem>
                {filteredProjects.map(p => (
                  <SelectItem key={p.id} value={p.project_id}>
                    {p.project_id} · {p.project_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="font-medium text-muted-foreground ml-3">Expense:</span>
            {inv.charge_to_entity && noLedgerEntities.has(inv.charge_to_entity) ? (
              <span className="inline-flex h-7 items-center rounded-md border border-border/60 bg-muted/40 px-2 text-[10px] text-muted-foreground">
                {inv.charge_to_entity} 唔使揀 Category — NetSuite 冇獨立 ledger，只出 Due From (AR)
              </span>
            ) : (
            <Select
              value={inv.expense_category || "__none__"}
              onValueChange={(v) => {
                if (v === "__none__") {
                  onUpdateInvoice({ expense_category: null, ns_account_number: null, ns_account_name: null });
                } else {
                  const cat = expenseCategories.find(c => c.category_key === v);
                  onUpdateInvoice({
                    expense_category: v,
                    ns_account_number: cat?.ns_account_number || null,
                    ns_account_name: cat?.label_en || null,
                  });
                }
              }}
            >
              <SelectTrigger className="h-7 text-[11px] w-[220px]">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— (auto)</SelectItem>
                {filteredCategories.length === 0 && inv.charge_to_entity && (
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{inv.charge_to_entity} 冇對應科目</div>
                )}
                {filteredCategories.map(c => (
                  <SelectItem key={c.id} value={c.category_key}>
                    {formatCategoryLabel(c.label_zh, c.ns_account_number)} · {c.ns_account_number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            )}
          </div>

          {/* Splits heading */}
          <div className="flex items-center gap-2 pt-1 border-t border-border/40">
            <SplitIcon size={12} className="text-muted-foreground" />
            <span className="text-[11px] font-semibold">Splits</span>
            <span className="text-[10px] text-muted-foreground">
              (1 invoice → multiple projects; each is 1 DR in journal)
            </span>
            {splits.length > 0 && (
              balanced
                ? <Badge variant="outline" className="text-[9px] px-1 py-0 text-green-700 dark:text-green-400 border-green-600/40">
                    {splits.length} splits · balanced
                  </Badge>
                : <Badge variant="outline" className="text-[9px] px-1 py-0 text-amber-700 dark:text-amber-400 border-amber-600/40">
                    diff {diff > 0 ? '+' : ''}{diff.toFixed(2)} HKD
                  </Badge>
            )}
          </div>

          {/* Splits list */}
          {splits.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/70 italic">
              No splits — the full {formatCurrency(invTotal)} will go to the invoice-level project above.
            </div>
          ) : (
            <div className="space-y-1">
              {splits.map((sp) => (
                <div key={sp.id} className="flex items-center gap-2">
                  <Select
                    value={sp.project_code || "__none__"}
                    onValueChange={(v) => onUpdateSplit(sp.id, { project_code: v === "__none__" ? null : v })}
                  >
                    <SelectTrigger className="h-7 text-[11px] w-[240px]">
                      <SelectValue placeholder="Project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— (unassigned)</SelectItem>
                      {filteredProjects.map(p => (
                        <SelectItem key={p.id} value={p.project_id}>
                          {p.project_id} · {p.project_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-7 text-[11px] w-[120px] tabular-nums"
                    defaultValue={Number(sp.amount_hkd).toFixed(2)}
                    onBlur={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (!isNaN(v) && v !== Number(sp.amount_hkd)) {
                        onUpdateSplit(sp.id, { amount_hkd: v });
                      }
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">HKD</span>
                  <Input
                    type="text"
                    placeholder="Note (optional)"
                    className="h-7 text-[11px] flex-1 max-w-[260px]"
                    defaultValue={sp.note || ""}
                    onBlur={(e) => {
                      const v = e.currentTarget.value || null;
                      if (v !== (sp.note || null)) onUpdateSplit(sp.id, { note: v });
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => onDeleteSplit(sp.id)}
                    title="Delete split"
                  >
                    <X size={14} />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add split */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => {
                const remaining = Math.max(0, invTotal - splitTotal);
                onAddSplit(inv.project_code || null, remaining > 0 ? remaining : 0);
              }}
            >
              <Plus size={12} className="mr-1" /> Add split
            </Button>
            {splits.length > 0 && !balanced && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                Sum must equal {formatCurrency(invTotal)}
              </span>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

type ViewMode = "table" | "card-split";

export default function ReconQueue() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [monthFilter, setMonthFilter] = useState<string>("all");
  const [cardFilter, setCardFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [selectedTxn, setSelectedTxn] = useState<TransactionFull | null>(null);
  const [modalType, setModalType] = useState<"assign" | "split" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmMassDelete, setConfirmMassDelete] = useState(false);
  const [confirmInvDelete, setConfirmInvDelete] = useState(false);
  const [expandedInvoices, setExpandedInvoices] = useState<Set<string>>(new Set());
  const [expandedTxnRow, setExpandedTxnRow] = useState<string | null>(null);
  const [selectedInvIds, setSelectedInvIds] = useState<Set<string>>(new Set());
  const [bulkEntity, setBulkEntity] = useState<string>("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ---- Queries ----

  const { data: transactions, isLoading } = useQuery({
    queryKey: ["recon-queue"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_transactions_full")
        .select("*")
        .order("txn_date", { ascending: false });
      if (error) throw error;
      return data as TransactionFull[];
    },
  });

  // Fetch parent invoices only (parent_invoice_id IS NULL) for the card-split view
  const { data: allInvoices } = useQuery({
    queryKey: ["invoices-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meta_invoices")
        .select("*")
        .is("parent_invoice_id", null)
        .order("invoice_date", { ascending: false });
      if (error) throw error;
      return data as MetaInvoice[];
    },
  });

  // Fetch child invoices (parent_invoice_id IS NOT NULL) for expandable detail
  const { data: childInvoices } = useQuery({
    queryKey: ["invoices-children"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meta_invoices")
        .select("*")
        .not("parent_invoice_id", "is", null)
        .order("amount", { ascending: false });
      if (error) throw error;
      return data as MetaInvoice[];
    },
  });

  // Fetch reconciliation results to map txn → invoice
  const { data: reconResults } = useQuery({
    queryKey: ["recon-results"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconciliation_results")
        .select("transaction_id, invoice_id, status");
      if (error) throw error;
      return data as { transaction_id: string; invoice_id: string | null; status: string }[];
    },
  });

  // Fetch invoice splits (one invoice → multiple project allocations)
  // Fail-safe: if the table doesn't exist yet (pending migration), return empty array so the page still loads.
  const { data: invoiceSplits } = useQuery({
    queryKey: ["invoice-splits"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meta_invoice_splits")
        .select("*")
        .order("sort_order", { ascending: true });
      if (error) {
        console.warn("[ReconQueue] meta_invoice_splits unavailable, continuing without splits:", error.message);
        return [] as MetaInvoiceSplit[];
      }
      return data as MetaInvoiceSplit[];
    },
    retry: false,
  });

  // Project code reference data (for split editor dropdown)
  const { data: projectCodes } = useQuery({
    queryKey: ["ns-project-codes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_project_codes")
        .select("*")
        .eq("is_active", true) // NetSuite 已停用嘅 project 唔再顯示
        .order("project_id", { ascending: true });
      if (error) {
        console.warn("[ReconQueue] ns_project_codes unavailable:", error.message);
        return [] as NsProjectCode[];
      }
      return data as NsProjectCode[];
    },
    retry: false,
  });

  // Expense categories (for inline account edit)
  const { data: expenseCategories } = useQuery({
    queryKey: ["expense-categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("*")
        .eq("is_active", true)
        .eq("admin_only", false) // 8100 admin a/c 只喺供應商付款申請用
        .order("sort_order", { ascending: true });
      if (error) {
        console.warn("[ReconQueue] expense_categories unavailable:", error.message);
        return [] as ExpenseCategory[];
      }
      return data as ExpenseCategory[];
    },
    retry: false,
  });

  // Account -> entity sharing map — used to filter expense categories by entity.
  // Sourced from ns_account_subsidiaries (the real NetSuite many-to-many
  // sharing); ns_chart_of_accounts.entity_code only records one "home" entity
  // per account and left the Category dropdown empty for shared entities (CLS).
  const { data: chartOfAccounts } = useQuery({
    queryKey: ["ns-account-subsidiary-map"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_account_subsidiaries")
        .select("account_number, entity_code");
      if (error) {
        console.warn("[ReconQueue] ns_account_subsidiaries unavailable:", error.message);
        return [] as { account_number: string; entity_code: string | null }[];
      }
      return data as { account_number: string; entity_code: string | null }[];
    },
    retry: false,
  });

  // entity_code -> Set<account_number>
  const accountsByEntity = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const a of chartOfAccounts || []) {
      if (!a.entity_code) continue;
      if (!map.has(a.entity_code)) map.set(a.entity_code, new Set());
      map.get(a.entity_code)!.add(a.account_number);
    }
    return map;
  }, [chartOfAccounts]);

  // ns_departments — 提供 Charge To picker (charge_to code + descriptive dept name)
  const { data: nsDepartmentsAll = [] } = useQuery({
    queryKey: ["ns_departments_recon_queue"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_departments")
        .select("entity_code, charge_to, name, subsidiary_name")
        .order("entity_code")
        .order("charge_to");
      if (error) throw error;
      return data as { entity_code: string; charge_to: string; name: string; subsidiary_name: string }[];
    },
  });

  // Fetch master credit-card list so we can show nicknames (Rex / Alex Lo etc)
  // instead of raw cardholder names from statements (MR WONG CHI FUNG etc).
  const { data: creditCardAccounts = [] } = useQuery({
    queryKey: ["ns_credit_card_accounts_recon"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_credit_card_accounts")
        .select("card_identifier, card_last4, cardholder_name, bank");
      if (error) return [];
      return (data || []) as { card_identifier: string; card_last4: string | null; cardholder_name: string; bank: string }[];
    },
    retry: false,
  });

  // Build last4 -> nickname map (eg "7428" -> "Rex")
  const last4ToNickname = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of creditCardAccounts) {
      if (c.card_last4) m.set(c.card_last4, c.card_identifier);
    }
    return m;
  }, [creditCardAccounts]);

  // Fetch batch file_paths + card association for invoice → original PDF mapping and card filtering
  const { data: batchFiles } = useQuery({
    queryKey: ["batch-files"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("upload_batches")
        .select("id, file_path, file_name, card_last4")
        .eq("upload_type", "meta_invoice");
      if (error) {
        console.warn("[ReconQueue] upload_batches unavailable:", error.message);
        return [] as { id: string; file_path: string | null; file_name: string; card_last4: string | null }[];
      }
      return data as { id: string; file_path: string | null; file_name: string; card_last4: string | null }[];
    },
    retry: false,
  });

  // ⭐ Fetch CC statement batch files (for showing original statement PDF in ReconQueue)
  const { data: ccStatementBatches } = useQuery({
    queryKey: ["cc-statement-batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("upload_batches")
        .select("id, file_path, file_name, statement_date, statement_period, card_last4")
        .eq("upload_type", "cc_statement");
      if (error) {
        console.warn("[ReconQueue] CC statement batches unavailable:", error.message);
        return [] as { id: string; file_path: string | null; file_name: string; statement_date: string | null; statement_period: string | null; card_last4: string | null }[];
      }
      return data as { id: string; file_path: string | null; file_name: string; statement_date: string | null; statement_period: string | null; card_last4: string | null }[];
    },
    retry: false,
  });

  // batch_id → CC statement file info
  const ccStatementMap = useMemo(() => {
    const m = new Map<string, { file_path: string | null; file_name: string; statement_date: string | null; statement_period: string | null }>();
    for (const b of ccStatementBatches || []) {
      m.set(b.id, { file_path: b.file_path, file_name: b.file_name, statement_date: b.statement_date, statement_period: b.statement_period });
    }
    return m;
  }, [ccStatementBatches]);

  // Map: batch_id -> card_last4 (for filtering invoices by card in recon panel)
  const batchToCard = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const b of batchFiles || []) m.set(b.id, b.card_last4);
    return m;
  }, [batchFiles]);

  // ---- Mutations ----

  const runEngineMutation = useMutation({
    mutationFn: async () => {
      // Fix: card_transactions / meta_invoices can exceed PostgREST's 1000-row
      // response cap. An unbounded select silently truncates at 1000, so the
      // engine would ignore every transaction/invoice past that and leave them
      // permanently unmatched. Page through with .range() until a short page.
      const fetchAll = async (
        make: (from: number, to: number) => any,
      ): Promise<any[]> => {
        const pageSize = 1000;
        let from = 0;
        const out: any[] = [];
        for (;;) {
          const { data, error } = await make(from, from + pageSize - 1);
          if (error) throw error;
          const chunk = data || [];
          out.push(...chunk);
          if (chunk.length < pageSize) break;
          from += pageSize;
        }
        return out;
      };

      const [txnData, invData, rulesRes, settingsRes, entRes, deptRes] = await Promise.all([
        fetchAll((f, t) => supabase.from("card_transactions").select("*").range(f, t)),
        fetchAll((f, t) => supabase.from("meta_invoices").select("*").is("parent_invoice_id", null).range(f, t)),
        supabase.from("matching_rules").select("*"),
        supabase.from("journal_settings").select("*").single(),
        supabase.from("entities").select("id, code"),
        supabase.from("departments").select("id, entity_id, code, dr_account"),
      ]);

      // Keep the { data } shape the rest of this function already expects.
      const txnRes = { data: txnData, error: null as any };
      const invRes = { data: invData, error: null as any };
      if (rulesRes.error) throw rulesRes.error;
      if (settingsRes.error) throw settingsRes.error;

      const { data: pendingRecon } = await supabase
        .from("reconciliation_results")
        .select("transaction_id")
        .in("status", ["pending", "unmatched"]);

      const pendingIds = new Set((pendingRecon || []).map(r => r.transaction_id));
      const pendingTxns = txnRes.data.filter(t => pendingIds.has(t.id));

      if (pendingTxns.length === 0) {
        throw new Error("No pending transactions to process");
      }

      const results = runMatchingEngine(
        pendingTxns,
        invRes.data,
        rulesRes.data,
        settingsRes.data,
        entRes.data || [],
        deptRes.data || []
      );

      // Fix: guard accounting_lines against duplicate inserts on re-run — collect
      // txn_ids that already have an accounting_lines row so a second run doesn't
      // double the expense in the journal. Query ONLY this run's transactions, in
      // chunks, so we never hit PostgREST's 1000-row cap (an unbounded select would
      // silently miss existing lines past row 1000 and re-insert them = doubled
      // expense at scale).
      const runTxnIds = results.map(r => r.transactionId);
      const existingLineTxnIds = new Set<string>();
      for (let i = 0; i < runTxnIds.length; i += 100) {
        const chunk = runTxnIds.slice(i, i + 100);
        const { data: existingLines, error: elErr } = await supabase
          .from("accounting_lines")
          .select("transaction_id")
          .in("transaction_id", chunk);
        if (elErr) throw elErr;
        for (const l of existingLines || []) existingLineTxnIds.add(l.transaction_id);
      }

      // Fix: track write failures (RLS/network) so we never report plain success
      // when the matching state was only partially persisted.
      let writeFailures = 0;

      for (const result of results) {
        const { error: rrErr } = await supabase
          .from("reconciliation_results")
          .update({
            status: result.status,
            match_type: result.matchType,
            confidence: result.confidence,
            invoice_id: result.invoiceId,
            matched_at: result.status === 'matched' ? new Date().toISOString() : null,
            matched_by: 'engine',
            notes: result.notes,
          })
          .eq("transaction_id", result.transactionId);
        if (rrErr) writeFailures++;

        // Mark invoice as matched regardless of entity/department availability.
        // Overwrite invoice.amount_hkd with the bank's actual HKD charge —
        // the CC statement is the source of truth for what really got billed.
        // Applies to BOTH HKD and FX invoices (HKD usually equal; FX gets bank's
        // real HKD figure with fees baked in).
        // Note: do NOT recompute fx_rate; storing a back-computed rate is misleading.
        if (result.status === 'matched' && result.invoiceId) {
          const txn = pendingTxns.find(t => t.id === result.transactionId);
          const bankHkd = txn ? Math.abs(Number(txn.amount_hkd) || Number(txn.amount) || 0) : 0;

          const invoicePatch: Record<string, any> = { is_matched: true };
          if (bankHkd > 0) {
            invoicePatch.amount_hkd = bankHkd;
          }
          const { error: invErr } = await supabase
            .from("meta_invoices")
            .update(invoicePatch)
            .eq("id", result.invoiceId);
          if (invErr) writeFailures++;

          // 分拆 invoice（parent+pieces）：配對嗰刻將 pieces 寫入 accounting_lines，
          // journal 直接按公司出數（每條 line 帶埋自己嗰份 Upload Centre 備註）。
          // 行咗呢步就唔會再行下面 rules-path 嘅單一 line。
          if (!existingLineTxnIds.has(result.transactionId)) {
            const { data: pieceKids, error: pkErr } = await supabase
              .from("meta_invoices")
              .select("amount, amount_hkd, charge_to_entity, charge_to_code, project_code, expense_category, ns_account_number, ns_account_name, notes, description")
              .eq("parent_invoice_id", result.invoiceId)
              .not("charge_to_code", "is", null);
            if (pkErr) writeFailures++;
            else if (pieceKids && pieceKids.length > 0) {
              const totalPieces = pieceKids.reduce((s, k) => s + (Number(k.amount_hkd ?? k.amount) || 0), 0);
              const lineRecords = pieceKids.map((k) => {
                const dept = (nsDepartmentsAll || []).find(d => d.charge_to === k.charge_to_code);
                const amt = Number(k.amount_hkd ?? k.amount) || 0;
                return {
                  transaction_id: result.transactionId,
                  amount_hkd: amt,
                  split_pct: totalPieces > 0 ? Math.round((amt / totalPieces) * 10000) / 100 : null,
                  ns_entity_code: k.charge_to_entity || dept?.entity_code || null,
                  ns_charge_to: k.charge_to_code,
                  ns_subsidiary_name: dept?.subsidiary_name || null,
                  ns_dept_name: dept?.name || null,
                  ns_account_number: k.ns_account_number || null,
                  ns_account_name: k.ns_account_name || null,
                  ns_project_code: k.project_code || null,
                  expense_category: k.expense_category || null,
                  dr_account: k.ns_account_number || "6000",
                  cr_account: "2100",
                  description: k.notes || k.description || null,
                };
              });
              const insAl = await supabase.from("accounting_lines").insert(lineRecords);
              if (insAl.error) writeFailures++;
              else existingLineTxnIds.add(result.transactionId);
            }
          }
        }

        if (result.status === 'matched' && result.entityId && result.departmentId) {
          const txn = pendingTxns.find(t => t.id === result.transactionId);
          if (txn) {
            // Pull invoice's charge_to_code so accounting_lines carries it for journal export.
            // (charge_to_code is the single source of truth for subsidiary + department mapping)
            let invChargeTo: string | null = null;
            let invSubsidiaryShort: string | null = null;
            if (result.invoiceId) {
              const matchedInv = invRes.data?.find((i: any) => i.id === result.invoiceId);
              invChargeTo = matchedInv?.charge_to_code || null;
              // If invoice lacks charge_to_code but has charge_to_entity, leave ns_charge_to null;
              // JournalExport will fallback via entityToDefaultChargeTo.
            }
            // Skip if this txn already has an accounting_lines row — inserting again
            // would double the expense in the exported journal.
            if (!existingLineTxnIds.has(result.transactionId)) {
              const { error: alErr } = await supabase.from("accounting_lines").insert({
                transaction_id: result.transactionId,
                entity_id: result.entityId,
                department_id: result.departmentId,
                amount_hkd: Number(txn.amount_hkd) || Number(txn.amount),
                split_pct: 100,
                dr_account: result.drAccount,
                cr_account: '2100',
                description: txn.merchant,
                ...(invChargeTo ? { ns_charge_to: invChargeTo } : {}),
                ...(invSubsidiaryShort ? { ns_subsidiary_name: invSubsidiaryShort } : {}),
              });
              if (alErr) writeFailures++;
              else existingLineTxnIds.add(result.transactionId);
            }
          }
        }
      }

      // ── Self-healing sweep ──
      // Backfill invoice_id on legacy reconciliation_results that were matched but stored a
      // NULL invoice_id (regression from older engine versions). Then sync is_matched on every
      // invoice that has a matched result pointing to it. This guarantees the dashboard's
      // "unmatched invoices" list never shows an invoice that's actually been reconciled.
      let healed = 0;
      const { data: brokenResults } = await supabase
        .from("reconciliation_results")
        .select("id, notes, transaction_id")
        .eq("status", "matched")
        .is("invoice_id", null);

      if (brokenResults?.length) {
        const { data: allInvs } = await supabase
          .from("meta_invoices")
          .select("id, invoice_number, parent_invoice_id")
          .is("parent_invoice_id", null);
        const invByNumber = new Map<string, string>();
        for (const inv of allInvs || []) {
          if (!invByNumber.has(inv.invoice_number)) invByNumber.set(inv.invoice_number, inv.id);
        }
        for (const r of brokenResults) {
          // Notes look like "Exact match: Invoice <number>" or "FX match: Invoice <number> (...)"
          // Capture the full token (\S+ keeps "." etc; [\w-]+ truncated it) and only
          // backfill when it EXACTLY equals an invoice's full invoice_number — a
          // truncated prefix could collide with a different invoice's number.
          const m = (r.notes || "").match(/Invoice\s+(\S+)/i);
          if (!m) continue;
          const invId = invByNumber.get(m[1]);
          if (!invId) continue;
          const { error: healErr } = await supabase.from("reconciliation_results").update({ invoice_id: invId }).eq("id", r.id);
          if (healErr) { writeFailures++; continue; }
          healed++;
        }
      }

      // Sync is_matched for every invoice that has a matched result
      const { data: allMatched } = await supabase
        .from("reconciliation_results")
        .select("invoice_id")
        .eq("status", "matched")
        .not("invoice_id", "is", null);
      const matchedInvIds = Array.from(new Set((allMatched || []).map(r => r.invoice_id).filter(Boolean) as string[]));
      let synced = 0;
      for (let i = 0; i < matchedInvIds.length; i += 100) {
        const chunk = matchedInvIds.slice(i, i + 100);
        const { error } = await supabase.from("meta_invoices").update({ is_matched: true }).in("id", chunk);
        if (!error) synced += chunk.length;
      }

      return {
        processed: results.length,
        matched: results.filter(r => r.status === 'matched').length,
        healed,
        synced,
        writeFailures,
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
      queryClient.invalidateQueries({ queryKey: ["recon-results"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      // If any per-row write failed, the persisted state is only partial — warn
      // loudly and do NOT report plain success.
      if (data.writeFailures > 0) {
        toast({
          title: "Matching incomplete",
          description: `${data.writeFailures} writes failed (RLS/network) — matching state may be inconsistent, re-run.`,
          variant: "destructive",
        });
        return;
      }
      const healedNote = data.healed > 0 ? ` Healed ${data.healed} legacy result(s).` : "";
      toast({
        title: "Matching complete",
        description: `Processed ${data.processed} transactions, ${data.matched} matched.${healedNote}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Matching failed", description: err.message, variant: "destructive" });
    },
  });

  // 刪除交易後，如果佢哋所屬嘅 upload batch 已經清空（冇晒 CC 交易同 invoice），
  // 一併刪走個 batch — 咁 Upload Centre 嘅上載紀錄先會同步消失，下次再 upload
  // 同一份 statement 唔會撞「已 import」而出 duplicates。
  const cleanupEmptyBatches = async (batchIds: (string | null | undefined)[]) => {
    const ids = Array.from(new Set(batchIds.filter(Boolean))) as string[];
    for (const bid of ids) {
      const [{ count: txnCount }, { count: invCount }] = await Promise.all([
        supabase.from("card_transactions").select("id", { count: "exact", head: true }).eq("batch_id", bid),
        supabase.from("meta_invoices").select("id", { count: "exact", head: true }).eq("batch_id", bid),
      ]);
      if ((txnCount ?? 0) === 0 && (invCount ?? 0) === 0) {
        // Best-effort: remove the stored PDF too, then the batch row itself.
        const { data: b } = await supabase.from("upload_batches").select("file_path").eq("id", bid).maybeSingle();
        if (b?.file_path) {
          await supabase.storage.from("documents").remove([b.file_path]).catch(() => undefined);
        }
        const delRes = await supabase.from("upload_batches").delete().eq("id", bid);
        if (delRes.error) console.warn("[ReconQueue] batch cleanup failed:", delRes.error.message);
      }
    }
  };

  const massDeleteMutation = useMutation({
    mutationFn: async (txnIds: string[]) => {
      const affectedBatchIds = (transactions || [])
        .filter(t => txnIds.includes(t.transaction_id))
        .map(t => t.batch_id);
      for (let i = 0; i < txnIds.length; i += 50) {
        const chunk = txnIds.slice(i, i + 50);
        // Check every delete — a discarded error let success toasts fire even when
        // nothing was deleted (e.g. RLS). Delete accounting_lines before card_transactions.
        const alRes = await supabase.from("accounting_lines").delete().in("transaction_id", chunk);
        if (alRes.error) throw alRes.error;
        const rrRes = await supabase.from("reconciliation_results").delete().in("transaction_id", chunk);
        if (rrRes.error) throw rrRes.error;
        const ctRes = await supabase.from("card_transactions").delete().in("id", chunk);
        if (ctRes.error) throw ctRes.error;
      }
      await cleanupEmptyBatches(affectedBatchIds);
      return txnIds.length;
    },
    onSuccess: (count) => {
      setSelectedIds(new Set());
      setConfirmMassDelete(false);
      queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
      queryClient.invalidateQueries({ queryKey: ["recon-results"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: "Deleted", description: `${count} transactions removed.` });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  // Unmatch (解除配對) — reverse a wrong match WITHOUT deleting the underlying
  // records: reset the reconciliation link to 'unmatched', clear is_matched on
  // the invoice, and drop the now-void accounting_lines. Both the CC transaction
  // and the invoice return to their Unmatched lists and stay re-matchable.
  const unmatchMutation = useMutation({
    mutationFn: async (input: { transactionIds?: string[]; invoiceIds?: string[] }) => {
      const txnIds = Array.from(new Set(input.transactionIds || []));
      const directInvIds = Array.from(new Set(input.invoiceIds || []));

      // Resolve every reconciliation row involved — by txn and by invoice — so we
      // capture both sides of each pair before we null out the links.
      const affectedTxnIds = new Set<string>(txnIds);
      const affectedInvIds = new Set<string>(directInvIds);
      const collect = async (col: "transaction_id" | "invoice_id", ids: string[]) => {
        for (let i = 0; i < ids.length; i += 100) {
          const chunk = ids.slice(i, i + 100);
          const { data, error } = await supabase
            .from("reconciliation_results")
            .select("transaction_id, invoice_id")
            .in(col, chunk);
          if (error) throw error;
          for (const r of data || []) {
            if (r.transaction_id) affectedTxnIds.add(r.transaction_id as string);
            if (r.invoice_id) affectedInvIds.add(r.invoice_id as string);
          }
        }
      };
      if (txnIds.length) await collect("transaction_id", txnIds);
      if (directInvIds.length) await collect("invoice_id", directInvIds);

      const allTxn = Array.from(affectedTxnIds);
      const allInv = Array.from(affectedInvIds);

      // Per transaction: drop the void GL lines, then reset the reconciliation
      // row to 'unmatched' (kept, not deleted, so "Run engine" still re-processes it).
      for (let i = 0; i < allTxn.length; i += 50) {
        const chunk = allTxn.slice(i, i + 50);
        const alRes = await supabase.from("accounting_lines").delete().in("transaction_id", chunk);
        if (alRes.error) throw alRes.error;
        const rrRes = await supabase
          .from("reconciliation_results")
          .update({
            status: "unmatched",
            invoice_id: null,
            match_type: null,
            confidence: null,
            matched_at: null,
            matched_by: "user",
            notes: "Unmatched by user",
          })
          .in("transaction_id", chunk);
        if (rrRes.error) throw rrRes.error;
      }

      // Return the invoices to the Unmatched list.
      for (let i = 0; i < allInv.length; i += 50) {
        const chunk = allInv.slice(i, i + 50);
        const miRes = await supabase.from("meta_invoices").update({ is_matched: false }).in("id", chunk);
        if (miRes.error) throw miRes.error;
      }

      return { txns: allTxn.length, invs: allInv.length };
    },
    onSuccess: (res) => {
      setSelectedIds(new Set());
      setSelectedInvIds(new Set());
      setConfirmMassDelete(false);
      queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
      queryClient.invalidateQueries({ queryKey: ["recon-results"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: "已解除配對", description: `${res.txns} 筆交易 · ${res.invs} 張發票 已退回 Unmatched` });
    },
    onError: (err: Error) => {
      toast({ title: "解除配對失敗", description: err.message, variant: "destructive" });
    },
  });

  // Manual pair (手動配對) — link ONE selected unmatched CC transaction to ONE
  // selected unmatched invoice. Mirrors AssignModal's invoice-link write path:
  // rr row → matched/manual, invoice → is_matched + bank's HKD figure.
  const manualPairMutation = useMutation({
    mutationFn: async (input: { txnId: string; invoiceId: string }) => {
      const txn = (transactions || []).find(t => t.transaction_id === input.txnId);
      const bankHkd = txn ? Math.abs(Number(txn.amount_hkd) || Number(txn.amount) || 0) : 0;

      const { data: existing, error: exErr } = await supabase
        .from("reconciliation_results")
        .select("id")
        .eq("transaction_id", input.txnId)
        .maybeSingle();
      if (exErr) throw exErr;

      const payload: any = {
        transaction_id: input.txnId,
        invoice_id: input.invoiceId,
        status: "matched",
        match_type: "manual",
        confidence: 100,
        matched_at: new Date().toISOString(),
        matched_by: "user",
        notes: "Manual pair",
      };
      if (existing?.id) {
        const { data: upd, error } = await supabase
          .from("reconciliation_results").update(payload).eq("id", existing.id).select();
        if (error) throw error;
        if (!upd || upd.length === 0) throw new Error("Update affected 0 rows (RLS?)");
      } else {
        const { data: ins, error } = await supabase
          .from("reconciliation_results").insert(payload).select();
        if (error) throw error;
        if (!ins || ins.length === 0) throw new Error("Insert affected 0 rows (RLS?)");
      }

      // Mark invoice matched; the CC statement's HKD figure is the source of truth.
      const invoicePatch: Record<string, any> = { is_matched: true };
      if (bankHkd > 0) invoicePatch.amount_hkd = bankHkd;
      const { data: invUpd, error: invErr } = await supabase
        .from("meta_invoices").update(invoicePatch).eq("id", input.invoiceId).select();
      if (invErr) throw invErr;
      if (!invUpd || invUpd.length === 0) throw new Error("Invoice update affected 0 rows (RLS?)");

      // 分拆 invoice（Upload Centre 一張拆幾間公司）：pieces 係 children，
      // 每份帶自己嘅 charge-to/category/金額。配對時自動將 pieces 寫入呢筆
      // 交易嘅 accounting_lines，journal 直接分公司出數 — 唔使再喺 Split 度重入一次。
      const { data: pieceKids, error: pkErr } = await supabase
        .from("meta_invoices")
        .select("amount, amount_hkd, charge_to_entity, charge_to_code, project_code, expense_category, ns_account_number, ns_account_name, notes, description")
        .eq("parent_invoice_id", input.invoiceId)
        .not("charge_to_code", "is", null);
      if (pkErr) throw pkErr;
      if (pieceKids && pieceKids.length > 0) {
        const totalPieces = pieceKids.reduce((s, k) => s + (Number(k.amount_hkd ?? k.amount) || 0), 0);
        const delAl = await supabase.from("accounting_lines").delete().eq("transaction_id", input.txnId);
        if (delAl.error) throw delAl.error;
        const lineRecords = pieceKids.map((k) => {
          const dept = (nsDepartmentsAll || []).find(d => d.charge_to === k.charge_to_code);
          const amt = Number(k.amount_hkd ?? k.amount) || 0;
          return {
            transaction_id: input.txnId,
            amount_hkd: amt,
            split_pct: totalPieces > 0 ? Math.round((amt / totalPieces) * 10000) / 100 : null,
            ns_entity_code: k.charge_to_entity || dept?.entity_code || null,
            ns_charge_to: k.charge_to_code,
            ns_subsidiary_name: dept?.subsidiary_name || null,
            ns_dept_name: dept?.name || null,
            ns_account_number: k.ns_account_number || null,
            ns_account_name: k.ns_account_name || null,
            ns_project_code: k.project_code || null,
            expense_category: k.expense_category || null,
            dr_account: k.ns_account_number || "6000",
            cr_account: "2100",
            description: k.notes || k.description || null,
          };
        });
        const insAl = await supabase.from("accounting_lines").insert(lineRecords);
        if (insAl.error) throw insAl.error;
      }
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      setSelectedInvIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
      queryClient.invalidateQueries({ queryKey: ["recon-results"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: "已配對", description: "交易同發票已手動配對，移到 Matched。" });
    },
    onError: (err: Error) => {
      toast({ title: "配對失敗", description: err.message, variant: "destructive" });
    },
  });

  // 刪除 invoice（連 children/splits 一齊）。有配對嘅交易會退回 unmatched；
  // batch 清空埋就連 upload 紀錄一齊刪 — 同 Upload Centre 同步，避免重複。
  const deleteInvoicesMutation = useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const affectedBatchIds = (allInvoices || [])
        .filter(inv => invoiceIds.includes(inv.id))
        .map(inv => inv.batch_id);

      // Children ids too — reconciliation rows may reference either level.
      const { data: kids, error: kidErr } = await supabase
        .from("meta_invoices").select("id").in("parent_invoice_id", invoiceIds);
      if (kidErr) throw kidErr;
      const allIds = [...invoiceIds, ...(kids || []).map(k => k.id)];

      // Unlink any reconciliation rows (FK is NO ACTION — must clear first).
      for (let i = 0; i < allIds.length; i += 100) {
        const chunk = allIds.slice(i, i + 100);
        const rrRes = await supabase
          .from("reconciliation_results")
          .update({ status: "unmatched", invoice_id: null, match_type: null, matched_at: null, notes: "Invoice deleted" })
          .in("invoice_id", chunk);
        if (rrRes.error) throw rrRes.error;
      }

      // Delete parents — children + splits cascade via FK.
      for (let i = 0; i < invoiceIds.length; i += 50) {
        const chunk = invoiceIds.slice(i, i + 50);
        const delRes = await supabase.from("meta_invoices").delete().in("id", chunk);
        if (delRes.error) throw delRes.error;
      }

      await cleanupEmptyBatches(affectedBatchIds);
      return invoiceIds.length;
    },
    onSuccess: (count) => {
      setSelectedInvIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
      queryClient.invalidateQueries({ queryKey: ["recon-results"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["batch-files"] });
      toast({ title: "已刪除", description: `${count} 張 invoice 已刪除（連上載紀錄同步清理）` });
    },
    onError: (err: Error) => {
      toast({ title: "刪除失敗", description: err.message, variant: "destructive" });
    },
  });

  const purgeOrphansMutation = useMutation({
    mutationFn: async () => {
      const { data: batches } = await supabase.from("upload_batches").select("id");
      const batchIds = new Set((batches || []).map(b => b.id));

      const { data: allTxns } = await supabase.from("card_transactions").select("id, batch_id");
      const orphanTxnIds = (allTxns || [])
        .filter(t => !t.batch_id || !batchIds.has(t.batch_id))
        .map(t => t.id);

      if (orphanTxnIds.length > 0) {
        for (let i = 0; i < orphanTxnIds.length; i += 50) {
          const chunk = orphanTxnIds.slice(i, i + 50);
          // Check every delete so a failed purge rejects instead of falsely reporting success.
          // Delete accounting_lines before card_transactions.
          const alRes = await supabase.from("accounting_lines").delete().in("transaction_id", chunk);
          if (alRes.error) throw alRes.error;
          const rrRes = await supabase.from("reconciliation_results").delete().in("transaction_id", chunk);
          if (rrRes.error) throw rrRes.error;
          const ctRes = await supabase.from("card_transactions").delete().in("id", chunk);
          if (ctRes.error) throw ctRes.error;
        }
      }

      const { data: allInvs } = await supabase.from("meta_invoices").select("id, batch_id");
      const orphanInvIds = (allInvs || [])
        .filter(inv => !inv.batch_id || !batchIds.has(inv.batch_id))
        .map(inv => inv.id);

      for (let i = 0; i < orphanInvIds.length; i += 50) {
        const chunk = orphanInvIds.slice(i, i + 50);
        const invRes = await supabase.from("meta_invoices").delete().in("id", chunk);
        if (invRes.error) throw invRes.error;
      }

      const { data: remainingTxns } = await supabase.from("card_transactions").select("id");
      const remainingTxnIds = new Set((remainingTxns || []).map(t => t.id));
      const { data: allRecon } = await supabase.from("reconciliation_results").select("id, transaction_id");
      const orphanReconIds = (allRecon || [])
        .filter(r => !remainingTxnIds.has(r.transaction_id))
        .map(r => r.id);

      for (let i = 0; i < orphanReconIds.length; i += 50) {
        const chunk = orphanReconIds.slice(i, i + 50);
        const rrRes = await supabase.from("reconciliation_results").delete().in("id", chunk);
        if (rrRes.error) throw rrRes.error;
      }

      return orphanTxnIds.length + orphanInvIds.length + orphanReconIds.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
      queryClient.invalidateQueries({ queryKey: ["recon-results"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({
        title: count === 0 ? "No orphan records" : "Cleanup done",
        description: count === 0 ? "All data is clean." : `${count} orphan records removed.`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Cleanup failed", description: err.message, variant: "destructive" });
    },
  });

  // ---- Derived data ----

  // batch_id → file_path mapping for invoices
  const batchFileMap = useMemo(() => {
    const map = new Map<string, { file_path: string | null; file_name: string }>();
    for (const bf of batchFiles || []) {
      map.set(bf.id, { file_path: bf.file_path, file_name: bf.file_name });
    }
    return map;
  }, [batchFiles]);

  // invoice_id → splits lookup
  const splitsByInvoice = useMemo(() => {
    const map = new Map<string, MetaInvoiceSplit[]>();
    for (const s of invoiceSplits || []) {
      const list = map.get(s.invoice_id) || [];
      list.push(s);
      map.set(s.invoice_id, list);
    }
    return map;
  }, [invoiceSplits]);

  // Add split mutation
  const addSplitMutation = useMutation({
    mutationFn: async (params: { invoiceId: string; projectCode: string | null; amountHkd: number; note: string | null; sortOrder: number }) => {
      const { error } = await supabase.from("meta_invoice_splits").insert({
        invoice_id: params.invoiceId,
        project_code: params.projectCode,
        amount_hkd: params.amountHkd,
        note: params.note,
        sort_order: params.sortOrder,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice-splits"] });
    },
    onError: (err: Error) => {
      toast({ title: "Add split failed", description: err.message, variant: "destructive" });
    },
  });

  // Update split mutation
  const updateSplitMutation = useMutation({
    mutationFn: async (params: { id: string; patch: Partial<Pick<MetaInvoiceSplit, 'project_code' | 'amount_hkd' | 'note'>> }) => {
      const { error } = await supabase
        .from("meta_invoice_splits")
        .update({ ...params.patch, updated_at: new Date().toISOString() })
        .eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice-splits"] });
    },
    onError: (err: Error) => {
      toast({ title: "Update split failed", description: err.message, variant: "destructive" });
    },
  });

  // Delete split mutation
  const deleteSplitMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("meta_invoice_splits").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice-splits"] });
    },
    onError: (err: Error) => {
      toast({ title: "Delete split failed", description: err.message, variant: "destructive" });
    },
  });

  // Update invoice project_code / account inline
  const updateInvoiceFieldMutation = useMutation({
    mutationFn: async (params: { id: string; patch: Partial<MetaInvoice> }) => {
      const { data, error } = await supabase
        .from("meta_invoices")
        .update(params.patch)
        .eq("id", params.id)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) {
        // RLS 阻擋咗 update — silent fail，要 throw 出嚟畀 user 知
        throw new Error("更新失敗：RLS 政策阻擋（請 run fix_rls_authenticated_write.sql）");
      }
    },
    onMutate: async (params) => {
      // Optimistic update — patch the cached invoice lists so UI reflects change instantly.
      await queryClient.cancelQueries({ queryKey: ["invoices-all"] });
      await queryClient.cancelQueries({ queryKey: ["invoices-children"] });
      const prevAll = queryClient.getQueryData<MetaInvoice[]>(["invoices-all"]);
      const prevChildren = queryClient.getQueryData<MetaInvoice[]>(["invoices-children"]);
      const patchList = (list: MetaInvoice[] | undefined) =>
        list?.map(inv => (inv.id === params.id ? { ...inv, ...params.patch } : inv));
      queryClient.setQueryData<MetaInvoice[]>(["invoices-all"], (old) => patchList(old) || old!);
      queryClient.setQueryData<MetaInvoice[]>(["invoices-children"], (old) => patchList(old) || old!);
      return { prevAll, prevChildren };
    },
    onSuccess: (_data, params) => {
      // Short toast confirms save
      const keys = Object.keys(params.patch).join(", ");
      toast({ title: "已更新", description: keys });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
    },
    onError: (err: Error, _params, ctx) => {
      // Rollback
      if (ctx?.prevAll) queryClient.setQueryData(["invoices-all"], ctx.prevAll);
      if (ctx?.prevChildren) queryClient.setQueryData(["invoices-children"], ctx.prevChildren);
      toast({ title: "Update invoice failed", description: err.message, variant: "destructive" });
    },
  });

  // parent_invoice_id → children lookup
  const childrenByParent = useMemo(() => {
    const map = new Map<string, MetaInvoice[]>();
    for (const child of childInvoices || []) {
      if (child.parent_invoice_id) {
        const list = map.get(child.parent_invoice_id) || [];
        list.push(child);
        map.set(child.parent_invoice_id, list);
      }
    }
    return map;
  }, [childInvoices]);

  const toggleExpandInvoice = useCallback((id: string) => {
    setExpandedInvoices(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ---- Bulk charge-to-entity ----
  const ENTITY_OPTIONS = [
    { code: "SSHK", label: "Social Strategy Hong Kong Limited" },
    { code: "PBHK", label: "Photoblog.hk Limited" },
    { code: "CLS", label: "CLS Production Limited" },
    { code: "JM", label: "Jervois M Limited" },
    { code: "704", label: "704 Production Limited" },
    { code: "EXT", label: "ExtravelIsm" },
    { code: "JS", label: "Jervois Solution" },
  ];

  const toggleInvSelect = useCallback((id: string) => {
    setSelectedInvIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAllInvs = useCallback((ids: string[]) => {
    setSelectedInvIds(prev => {
      const allSelected = ids.every(id => prev.has(id));
      if (allSelected) return new Set(); // deselect all
      return new Set(ids);
    });
  }, []);

  const bulkUpdateEntity = useMutation({
    mutationFn: async () => {
      if (!bulkEntity || selectedInvIds.size === 0) return;
      const ids = Array.from(selectedInvIds);
      // Update in chunks of 50
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        // Also clear charge_to_code: a stale code would override the new entity in
        // the journal (subsidiary/department derive from charge_to_code first).
        // Nulling it lets the journal re-derive from the new charge_to_entity.
        // project_code is left untouched.
        const { error } = await supabase
          .from("meta_invoices")
          .update({ charge_to_entity: bulkEntity, charge_to_code: null })
          .in("id", chunk);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast({ title: "已更新", description: `${selectedInvIds.size} 條 invoice 已標記為 ${bulkEntity}（Charge To 已重設，將重新推導）` });
      setSelectedInvIds(new Set());
      setBulkEntity("");
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
      queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
      queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
    },
    onError: (err: any) => {
      toast({ title: "更新失敗", description: err.message, variant: "destructive" });
    },
  });

  // Open original invoice PDF in new tab
  const openInvoicePdf = useCallback(async (batchId: string | null) => {
    if (!batchId) return;
    const bf = batchFileMap.get(batchId);
    if (!bf || !bf.file_path) {
      toast({ title: "No file", description: "Original file not found for this invoice.", variant: "destructive" });
      return;
    }
    const { data } = await supabase.storage.from("documents").createSignedUrl(bf.file_path, 3600);
    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
    } else {
      toast({ title: "Error", description: "Could not generate file link.", variant: "destructive" });
    }
  }, [batchFileMap, toast]);

  // ⭐ Open original CC statement PDF
  const openCcStatementPdf = useCallback(async (batchId: string | null) => {
    if (!batchId) return;
    const stmt = ccStatementMap.get(batchId);
    if (!stmt || !stmt.file_path) {
      toast({ title: "未找到", description: "這條 transaction 不能連接原件 statement PDF。", variant: "destructive" });
      return;
    }
    const { data } = await supabase.storage.from("documents").createSignedUrl(stmt.file_path, 3600);
    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
    } else {
      toast({ title: "錯誤", description: "無法生成 PDF 連接。", variant: "destructive" });
    }
  }, [ccStatementMap, toast]);

  const availableMonths = useMemo(() =>
    Array.from(
      new Set((transactions || []).map(t => t.txn_date?.substring(0, 7)).filter(Boolean))
    ).sort().reverse(),
    [transactions]
  );

  // Build a stable card key. A “card group” = one uploaded statement file =
  // one batch_id. This keeps a statement that crosses two calendar months
  // (e.g. 2025-12-26 → 2026-01-25) as one unit, instead of splitting it by
  // each transaction's own month.
  //
  // Fallback: if batch_id is missing (very old data), fall back to
  // holder|last4|period_month so we don't lose those rows.
  const cardKeyOf = (t: {
    batch_id?: string | null;
    card_last4?: string | null;
    cardholder_name?: string | null;
    period_month?: string | null;
    txn_date?: string | null;
  }) => {
    if (t.batch_id) return `batch:${t.batch_id}`;
    const holder = (t.cardholder_name || '').trim();
    const last4 = (t.card_last4 || '').trim();
    const month = (t.period_month || (t.txn_date || '').slice(0, 7) || '').trim();
    return `legacy:${holder}|${last4}|${month}`;
  };

  const availableCards = useMemo(() => {
    // Group transactions by key, collect representative metadata + span of months.
    type CardInfo = {
      key: string;
      last4: string;
      cardholder: string | null;
      monthStart: string;
      monthEnd: string;
      bank: string | null;
      count: number;
    };
    const cardSet = new Map<string, CardInfo>();
    for (const t of transactions || []) {
      const key = cardKeyOf(t);
      if (key === 'legacy:||') continue;
      const m = (t.period_month || (t.txn_date || '').slice(0, 7) || '').trim();
      const existing = cardSet.get(key);
      if (existing) {
        existing.count++;
        if (m && (!existing.monthStart || m < existing.monthStart)) existing.monthStart = m;
        if (m && (!existing.monthEnd || m > existing.monthEnd)) existing.monthEnd = m;
      } else {
        cardSet.set(key, {
          key,
          last4: (t.card_last4 || '').trim(),
          cardholder: (t.cardholder_name || '').trim() || null,
          monthStart: m,
          monthEnd: m,
          bank: t.card_bank,
          count: 1,
        });
      }
    }
    // Sort: most recent statement first, then by txn count
    return Array.from(cardSet.values())
      .map(c => ({
        ...c,
        // Combined month label: "2025-12 → 2026-01" if spans, else "2026-01"
        month: c.monthStart === c.monthEnd ? c.monthEnd : `${c.monthStart} → ${c.monthEnd}`,
      }))
      .sort((a, b) => {
        if (b.monthEnd !== a.monthEnd) return b.monthEnd.localeCompare(a.monthEnd);
        return b.count - a.count;
      });
  }, [transactions]);

  // Hide credit-card payment rows (找數 / Payment Received / Thank You) everywhere in the
  // reconciliation UI — these are card payments, not real expenses, and should not appear
  // in matched / unmatched lists even if legacy data still has them.
  const CC_PAYMENT_PATTERN = /payment\s*received|thank\s*you|auto[\s-]*pay|autopay|ifs\s*payment|自動轉帳|找數|繳款|還款/i;

  const baseFiltered = useMemo(() =>
    (transactions || []).filter(t => {
      // Filter out CC payment rows
      const m = (t.merchant || "").toString();
      const d = (t.description || "").toString();
      if (CC_PAYMENT_PATTERN.test(m) || CC_PAYMENT_PATTERN.test(d)) return false;

      if (monthFilter !== "all" && t.txn_date?.substring(0, 7) !== monthFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        return (
          t.merchant.toLowerCase().includes(s) ||
          (t.reference || '').toLowerCase().includes(s) ||
          (t.invoice_number || '').toLowerCase().includes(s) ||
          (t.card_last4 || '').includes(s)
        );
      }
      return true;
    }),
    [transactions, monthFilter, search]
  );

  const tableFiltered = useMemo(() =>
    baseFiltered.filter(t => {
      if (statusFilter !== "all" && t.match_status !== statusFilter) return false;
      if (cardFilter !== "all" && cardKeyOf(t) !== cardFilter) return false;
      return true;
    }),
    [baseFiltered, statusFilter, cardFilter]
  );
  const tablePg = usePagination(tableFiltered, 50);

  // Build lookup maps for card-split view
  const invoiceMap = useMemo(() => {
    const map = new Map<string, MetaInvoice>();
    for (const inv of allInvoices || []) {
      map.set(inv.id, inv);
    }
    return map;
  }, [allInvoices]);

  // txn_id → invoice_id mapping from recon results
  const txnToInvoiceId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reconResults || []) {
      if (r.invoice_id && (r.status === 'matched' || r.status === 'manual')) {
        map.set(r.transaction_id, r.invoice_id);
      }
    }
    return map;
  }, [reconResults]);

  // Set of matched invoice IDs
  const matchedInvoiceIds = useMemo(() => {
    return new Set(Array.from(txnToInvoiceId.values()));
  }, [txnToInvoiceId]);

  // Set of currently-matched transaction IDs (match_status is rr.status via the
  // view). Used to show the Unmatch action only when the selection actually
  // contains a matched item.
  const matchedTxnIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const t of transactions || []) {
      if (t.match_status === "matched" || t.match_status === "manual") s.add(t.transaction_id);
    }
    return s;
  }, [transactions]);

  // 4-panel data for card-split view
  const cardPanelData = useMemo(() => {
    const selectedCard = cardFilter !== "all" ? cardFilter : null;
    if (!selectedCard) return null;

    // baseFiltered already excludes CC payment rows, so we can trust all entries here.
    const cardTxns = baseFiltered.filter(t => cardKeyOf(t) === selectedCard);
    const matchedTxns = cardTxns.filter(t => t.match_status === 'matched' || t.match_status === 'manual');
    const unmatchedTxns = cardTxns.filter(t => t.match_status !== 'matched' && t.match_status !== 'manual');

    // Matched invoices: invoices linked to matched txns of this card
    const matchedInvs: MetaInvoice[] = [];
    const matchedInvIdSet = new Set<string>();
    for (const txn of matchedTxns) {
      const invId = txnToInvoiceId.get(txn.transaction_id);
      if (invId && !matchedInvIdSet.has(invId)) {
        const inv = invoiceMap.get(invId);
        if (inv) {
          matchedInvs.push(inv);
          matchedInvIdSet.add(invId);
        }
      }
    }

    // Build paired rows: each row is a (txn, invoice) pair for side-by-side display
    // Sort by txn_date desc so newest at top on the LEFT side
    const matchedPairs: Array<{ txn: typeof matchedTxns[number] | null; inv: MetaInvoice | null }> = [];
    const pairedInvIds = new Set<string>();
    const sortedMatchedTxns = [...matchedTxns].sort((a, b) => (b.txn_date || '').localeCompare(a.txn_date || ''));
    for (const txn of sortedMatchedTxns) {
      const invId = txnToInvoiceId.get(txn.transaction_id);
      const inv = invId ? invoiceMap.get(invId) : null;
      matchedPairs.push({ txn, inv: inv || null });
      if (inv) pairedInvIds.add(inv.id);
    }
    // Orphan matched invoices (invoice marked matched but no CC txn reference) — append at bottom
    for (const inv of matchedInvs) {
      if (!pairedInvIds.has(inv.id)) {
        matchedPairs.push({ txn: null, inv });
      }
    }

    // Unmatched invoices: all invoices not yet matched (filtered by month + card if applicable)
    // Card filter: if invoice's batch is tagged to a specific card, only show on that card's panel.
    // Invoices with no card tag (legacy or uncategorised) show on every card panel.
    const unmatchedInvs = (allInvoices || []).filter(inv => {
      if (matchedInvoiceIds.has(inv.id)) return false;
      if (inv.is_matched) return false;
      if (monthFilter !== "all" && inv.invoice_date?.substring(0, 7) !== monthFilter) return false;
      const invCard = inv.batch_id ? batchToCard.get(inv.batch_id) : null;
      if (invCard && invCard !== selectedCard) return false;
      return true;
    });

    return { matchedTxns, unmatchedTxns, matchedInvs, unmatchedInvs, matchedPairs };
  }, [baseFiltered, cardFilter, txnToInvoiceId, invoiceMap, matchedInvoiceIds, allInvoices, monthFilter, batchToCard]);

  // ---- Handlers ----

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((ids: string[]) => {
    setSelectedIds(prev => {
      const allSelected = ids.every(id => prev.has(id));
      const next = new Set(prev);
      if (allSelected) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const handleModalClose = () => { setSelectedTxn(null); setModalType(null); };
  const handleModalSaved = () => {
    handleModalClose();
    queryClient.invalidateQueries({ queryKey: ["recon-queue"] });
    queryClient.invalidateQueries({ queryKey: ["invoices-all"] });
    queryClient.invalidateQueries({ queryKey: ["invoices-children"] });
    queryClient.invalidateQueries({ queryKey: ["recon-results"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  // ---- Sub-components ----

  // 手動配對 — enabled when exactly ONE unmatched CC txn + ONE unmatched invoice
  // are ticked. Rendered in both action bars.
  const ManualPairButton = () => {
    if (selectedIds.size !== 1 || selectedInvIds.size !== 1) return null;
    const txnId = Array.from(selectedIds)[0];
    const invId = Array.from(selectedInvIds)[0];
    if (matchedTxnIdSet.has(txnId) || matchedInvoiceIds.has(invId)) return null;
    return (
      <Button size="sm" className="h-7 text-xs"
        disabled={manualPairMutation.isPending}
        onClick={() => manualPairMutation.mutate({ txnId, invoiceId: invId })}
        data-testid="button-manual-pair"
        title="將已選嘅 1 筆 CC 交易同 1 張發票直接配對">
        {manualPairMutation.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : <Link2 size={12} className="mr-1" />}
        手動配對
      </Button>
    );
  };

  const MassActionBar = () => {
    if (selectedIds.size === 0) return null;
    const selectedMatchedCount = Array.from(selectedIds).filter(id => matchedTxnIdSet.has(id)).length;
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-destructive/10 border border-destructive/20 rounded-lg">
        <span className="text-sm font-medium">{selectedIds.size} selected</span>
        <ManualPairButton />
        {selectedMatchedCount > 0 && !confirmMassDelete && (
          <Button variant="outline" size="sm" className="h-7 text-xs"
            disabled={unmatchMutation.isPending}
            onClick={() => unmatchMutation.mutate({ transactionIds: Array.from(selectedIds) })}
            data-testid="button-unmatch-selected"
            title="解除配對，將交易同發票退回 Unmatched（唔會刪除資料）">
            {unmatchMutation.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : <Unlink size={12} className="mr-1" />}
            解除配對 ({selectedMatchedCount})
          </Button>
        )}
        {!confirmMassDelete ? (
          <Button variant="destructive" size="sm" className="h-7 text-xs"
            onClick={() => setConfirmMassDelete(true)} data-testid="button-mass-delete">
            <Trash2 size={12} className="mr-1" /> Delete selected
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-destructive">Confirm delete {selectedIds.size} items?</span>
            <Button variant="destructive" size="sm" className="h-7 text-xs"
              disabled={massDeleteMutation.isPending}
              onClick={() => massDeleteMutation.mutate(Array.from(selectedIds))}
              data-testid="button-confirm-mass-delete">
              {massDeleteMutation.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
              Yes, delete
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs"
              onClick={() => setConfirmMassDelete(false)}>Cancel</Button>
          </div>
        )}
        <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto"
          onClick={() => { setSelectedIds(new Set()); setConfirmMassDelete(false); }}>
          Clear selection
        </Button>
      </div>
    );
  };

  // ---- Card selector grid ----
  const CardSelectorGrid = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {availableCards.map(c => {
        const cardTxns = baseFiltered.filter(t => cardKeyOf(t) === c.key);
        const matchedCount = cardTxns.filter(t => t.match_status === 'matched' || t.match_status === 'manual').length;
        const unmatchedCount = cardTxns.length - matchedCount;
        const totalAmount = cardTxns.reduce((sum, t) => sum + (t.amount_hkd ?? t.amount ?? 0), 0);
        // Prefer the friendly nickname from ns_credit_card_accounts (Rex / Alex Lo / Kenneth)
        // over the raw statement cardholder name (MR WONG CHI FUNG etc).
        const nickname = c.last4 ? last4ToNickname.get(c.last4) : undefined;
        const friendlyHolder = nickname || c.cardholder;
        const displayLabel = friendlyHolder
          ? (c.last4 ? `${friendlyHolder} ····${c.last4}` : friendlyHolder)
          : (c.last4 || 'Unknown card');
        // Format month as "2026-01" -> "Jan 2026" for nicer display
        const formatMonth = (m: string) => {
          if (!m || !/^\d{4}-\d{2}$/.test(m)) return m;
          const [y, mo] = m.split('-');
          const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          return `${monthNames[parseInt(mo)-1]} ${y}`;
        };
        const monthLabel = formatMonth(c.month);
        const subLabel = [monthLabel, c.bank].filter(Boolean).join(' · ');

        return (
          <Card key={c.key} className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => setCardFilter(c.key)} data-testid={`card-select-${c.key}`}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <CreditCard size={20} className="text-muted-foreground" />
                <div>
                  <div className="font-semibold text-base truncate">{displayLabel}</div>
                  {subLabel && <div className="text-xs text-muted-foreground">{subLabel}</div>}
                </div>
              </div>
              <div className="text-lg font-semibold tabular-nums mb-2">{formatCurrency(totalAmount)}</div>
              <div className="flex gap-4 text-xs">
                <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                  <CheckCircle2 size={12} /> {matchedCount} matched
                </span>
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertCircle size={12} /> {unmatchedCount} unmatched
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  // ---- Render ----

  return (
    <div className="p-6 space-y-4 max-w-[1600px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Reconciliation Queue</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {transactions?.length ?? 0} transactions · {viewMode === 'table' ? tableFiltered.length : (cardPanelData ? cardPanelData.matchedTxns.length + cardPanelData.unmatchedTxns.length : 0)} shown
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => purgeOrphansMutation.mutate()}
            disabled={purgeOrphansMutation.isPending} className="text-xs" data-testid="button-purge-orphans">
            {purgeOrphansMutation.isPending ? <Loader2 size={14} className="animate-spin mr-1" /> : <Trash2 size={14} className="mr-1" />}
            Clean orphans
          </Button>
          <div className="flex border border-border rounded-md overflow-hidden">
            <button className={`px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === 'table' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => setViewMode('table')} data-testid="button-view-table">Table</button>
            <button className={`px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === 'card-split' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => setViewMode('card-split')} data-testid="button-view-card-split">
              <CreditCard size={12} className="inline mr-1" />By Card
            </button>
          </div>
          <Button onClick={() => runEngineMutation.mutate()} disabled={runEngineMutation.isPending} data-testid="button-run-engine">
            {runEngineMutation.isPending
              ? <><Loader2 className="animate-spin mr-2" size={16} /> Running...</>
              : <><Play className="mr-2" size={16} /> Run Matching</>}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <Input placeholder="Search merchant, reference, invoice..." value={search}
            onChange={e => setSearch(e.target.value)} className="pl-9" data-testid="input-search" />
        </div>
        <Select value={monthFilter} onValueChange={setMonthFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-month-filter">
            <Calendar size={14} className="mr-2" /><SelectValue placeholder="All months" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All months</SelectItem>
            {availableMonths.filter(m => !!m).map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={cardFilter} onValueChange={setCardFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-card-filter">
            <CreditCard size={14} className="mr-2" /><SelectValue placeholder="All cards" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All cards</SelectItem>
            {availableCards.filter(c => !!c.key && c.key !== '||').map(c => {
              const nickname = c.last4 ? last4ToNickname.get(c.last4) : undefined;
              const display = nickname || c.cardholder || '?';
              return (
                <SelectItem key={c.key} value={c.key}>
                  {display} · {c.last4 || '----'} · {c.month || '——'} {c.bank ? `(${c.bank})` : ''} — {c.count} txns
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {viewMode === 'table' && (
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
              <Filter size={14} className="mr-2" /><SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="matched">Matched</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="unmatched">Unmatched</SelectItem>
              <SelectItem value="exception">Exception</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Mass action bar */}
      <MassActionBar />

      {/* Content */}
      {isLoading ? (
        <Card><CardContent className="p-6 space-y-3">
          {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent></Card>
      ) : viewMode === 'table' ? (
        /* ===== TABLE VIEW ===== */
        <Card>
          <CardContent className="p-0">
            {tableFiltered.length === 0 ? (
              <div className="p-10 text-center text-muted-foreground text-sm">
                {transactions?.length === 0 ? "No transactions yet. Upload a CC statement to get started." : "No transactions match your filters."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full table-dense">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2.5 w-8">
                        <Checkbox checked={tableFiltered.length > 0 && tableFiltered.every(t => selectedIds.has(t.transaction_id))}
                          onCheckedChange={() => toggleSelectAll(tableFiltered.map(t => t.transaction_id))} data-testid="checkbox-select-all" />
                      </th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Date</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Statement</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Merchant</th>
                      <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2.5">Amount</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Currency</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Cardholder</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Status</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Match</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Invoice</th>
                      <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2.5">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tablePg.pageItems.map(txn => {
                      const isExpanded = expandedTxnRow === txn.transaction_id;
                      const invId = txnToInvoiceId.get(txn.transaction_id);
                      const matchedInv = invId ? invoiceMap.get(invId) : null;
                      const invChildren = matchedInv ? (childInvoices || []).filter(c => c.parent_invoice_id === matchedInv.id) : [];
                      return (
                      <>
                      <tr key={txn.transaction_id}
                        className={`border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer ${selectedIds.has(txn.transaction_id) ? 'bg-primary/5' : ''} ${isExpanded ? 'bg-muted/30' : ''}`}
                        onClick={() => setExpandedTxnRow(isExpanded ? null : txn.transaction_id)}
                        data-testid={`row-txn-${txn.transaction_id}`}>
                        <td className="px-3 py-2 w-8" onClick={e => e.stopPropagation()}>
                          <Checkbox checked={selectedIds.has(txn.transaction_id)}
                            onCheckedChange={() => toggleSelect(txn.transaction_id)} />
                        </td>
                        <td className="px-3 py-2 text-sm tabular-nums whitespace-nowrap">{txn.txn_date}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground" onClick={e => e.stopPropagation()}>
                          {txn.batch_id && ccStatementMap.has(txn.batch_id) ? (() => {
                            const stmt = ccStatementMap.get(txn.batch_id)!;
                            return (
                              <button
                                className="flex items-center gap-1 text-primary hover:text-primary/80 hover:underline"
                                title={`看原件 statement：${stmt.file_name}${stmt.statement_date ? ` · 出單日 ${stmt.statement_date}` : ''}`}
                                onClick={(e) => { e.stopPropagation(); openCcStatementPdf(txn.batch_id); }}
                                data-testid={`button-view-statement-${txn.transaction_id}`}
                              >
                                <FileText size={12} />
                                <span className="truncate max-w-[100px]">{stmt.statement_date || stmt.statement_period || 'PDF'}</span>
                              </button>
                            );
                          })() : <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-3 py-2 text-sm font-medium truncate max-w-[200px]">{txn.merchant}</td>
                        <td className="px-3 py-2 text-sm text-right tabular-nums font-medium">
                          {/* amount_hkd is HKD-converted — label it HKD, not the foreign currency */}
                          {formatCurrency(txn.amount_hkd ?? txn.amount, txn.amount_hkd != null ? "HKD" : txn.currency)}
                        </td>
                        <td className="px-3 py-2 text-sm text-muted-foreground">{txn.currency}</td>
                        <td className="px-3 py-2 text-sm text-muted-foreground">
                          {txn.card_last4 || '—'}
                        </td>
                        <td className="px-3 py-2"><StatusBadge status={txn.match_status} /></td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{txn.match_type || '—'}</td>
                        <td className="px-3 py-2 text-sm text-muted-foreground">
                          <div className="flex items-center gap-1 max-w-[140px]">
                            <span className="truncate">{txn.invoice_number || '—'}</span>
                            {txn.invoice_number && (() => {
                              const inv = matchedInv;
                              return inv?.batch_id && batchFileMap.has(inv.batch_id) ? (
                                <button
                                  className="text-primary hover:text-primary/80 flex-shrink-0"
                                  title="View original invoice"
                                  onClick={(e) => { e.stopPropagation(); openInvoicePdf(inv.batch_id); }}
                                  data-testid={`button-view-invoice-${txn.transaction_id}`}
                                >
                                  <ExternalLink size={12} />
                                </button>
                              ) : null;
                            })()}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right" onClick={e => e.stopPropagation()}>
                          <div className="flex gap-1 justify-end">
                            <Button variant="ghost" size="sm" className="text-xs h-7 px-2"
                              onClick={() => { setSelectedTxn(txn); setModalType("assign"); }}>Assign</Button>
                            <Button variant="ghost" size="sm" className="text-xs h-7 px-2"
                              onClick={() => { setSelectedTxn(txn); setModalType("split"); }}>Split</Button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${txn.transaction_id}-detail`} className="bg-muted/10 border-b border-border/50">
                          <td colSpan={11} className="px-6 py-3">
                            {matchedInv ? (
                              <div className="flex items-start gap-3 text-sm">
                                <FileText size={16} className="text-primary mt-0.5 flex-shrink-0" />
                                <div className="space-y-2 flex-1">
                                  <p className="font-medium text-xs text-muted-foreground uppercase tracking-wider">已配對 Invoice</p>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1.5">
                                    <div className="text-xs">
                                      <span className="text-muted-foreground">Invoice #: </span>
                                      <span className="font-medium">{matchedInv.invoice_number}</span>
                                    </div>
                                    <div className="text-xs">
                                      <span className="text-muted-foreground">Amount: </span>
                                      <span className="font-medium tabular-nums"><InvAmount inv={matchedInv} /></span>
                                    </div>
                                    <div className="text-xs">
                                      <span className="text-muted-foreground">Date: </span>
                                      <span>{matchedInv.invoice_date || '—'}</span>
                                    </div>
                                    <div className="text-xs">
                                      <span className="text-muted-foreground">Account: </span>
                                      <span>{matchedInv.account_name || '—'}</span>
                                    </div>
                                  </div>
                                  {matchedInv.description && (
                                    <p className="text-xs text-muted-foreground">{matchedInv.description}</p>
                                  )}
                                  {invChildren.length > 0 && (
                                    <div className="mt-2 border-t border-border/50 pt-2">
                                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">子項目 ({invChildren.length})</p>
                                      <div className="space-y-1">
                                        {invChildren.map(child => (
                                          <div key={child.id} className="flex items-center gap-4 text-xs py-1 px-2 rounded bg-background/50">
                                            <span className="text-muted-foreground w-28 truncate">{child.invoice_number}</span>
                                            <span className="tabular-nums font-medium"><InvAmount inv={child} /></span>
                                            <span className="text-muted-foreground truncate flex-1">{child.description || '—'}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {matchedInv.batch_id && batchFileMap.has(matchedInv.batch_id) && (
                                    <button
                                      className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 mt-1"
                                      onClick={(e) => { e.stopPropagation(); openInvoicePdf(matchedInv.batch_id); }}
                                    >
                                      <ExternalLink size={11} /> 查看原始 Invoice PDF
                                    </button>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <FileText size={14} className="text-muted-foreground/50" />
                                <span>未有配對的 Invoice</span>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                      </>
                    );
                    })}
                  </tbody>
                </table>
                <div className="px-3 pb-2">
                  <PaginationFooter {...tablePg.footerProps} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        /* ===== CARD SPLIT VIEW (4-panel) ===== */
        <div className="space-y-6">
          {cardFilter === "all" && availableCards.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-muted-foreground text-sm">
              No card data found. Upload a CC statement first.
            </CardContent></Card>
          ) : cardFilter === "all" ? (
            <CardSelectorGrid />
          ) : cardPanelData ? (
            <>
              {/* Card summary */}
              <div className="flex items-center gap-3 px-4 py-3 bg-muted/40 rounded-lg border border-border">
                <CreditCard size={18} className="text-muted-foreground" />
                <span className="font-semibold truncate">{cardFilter}</span>
                <span className="text-sm text-muted-foreground">
                  {cardPanelData.matchedTxns.length + cardPanelData.unmatchedTxns.length} CC entries · {cardPanelData.matchedInvs.length + cardPanelData.unmatchedInvs.length} invoices
                </span>
                <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => setCardFilter("all")}>
                  ← All cards
                </Button>
              </div>

              {/* ── TOP ROW: MATCHED (pair-aligned: CC left ↔ Invoice right, one row per pair) ── */}
              <div>
                <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                  <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" />
                  Matched
                  <span className="text-xs font-normal text-muted-foreground ml-2">
                    — 已兑的帳面左右同步顯示
                  </span>
                </h2>
                <Card>
                  <CardHeader className="pb-2 pt-3 px-4">
                    <div className="grid grid-cols-2 gap-4">
                      <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground">
                        <CreditCard size={14} />
                        CC Transactions ({cardPanelData.matchedTxns.length})
                        <span className="ml-auto tabular-nums">
                          {formatCurrency(cardPanelData.matchedTxns.reduce((s, t) => s + (t.amount_hkd ?? t.amount ?? 0), 0))}
                        </span>
                      </CardTitle>
                      <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground">
                        <FileText size={14} />
                        Invoices ({cardPanelData.matchedInvs.length})
                        <span className="ml-auto tabular-nums">
                          {formatCurrency(cardPanelData.matchedInvs.reduce((s, inv) => s + invHkd(inv), 0))}
                        </span>
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    {cardPanelData.matchedPairs.length === 0 ? (
                      <div className="p-6 text-center text-muted-foreground text-xs">No matched entries.</div>
                    ) : (
                      <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                        <table className="w-full table-dense">
                          <thead className="sticky top-0 bg-background z-10">
                            <tr className="border-b border-border bg-muted/30">
                              {/* Left (CC) — 4 cols */}
                              <th className="px-2 py-2 w-6"></th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2 whitespace-nowrap">Date</th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2">Merchant</th>
                              <th className="text-right text-[10px] font-medium text-muted-foreground px-2 py-2 whitespace-nowrap">Amount</th>
                              {/* Divider */}
                              <th className="w-px bg-border p-0"></th>
                              {/* Right (Invoice) — 10 cols */}
                              <th className="px-2 py-2 w-6"></th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2 whitespace-nowrap">Date</th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2">Invoice #</th>
                              <th className="text-right text-[10px] font-medium text-muted-foreground px-2 py-2 whitespace-nowrap">Amount</th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2 w-[55px]">Charge</th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2 w-[65px]">Project</th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2 w-[80px]">Account</th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2 w-[110px]">備註</th>
                              <th className="text-left text-[10px] font-medium text-muted-foreground px-2 py-2">Description</th>
                              <th className="text-center text-[10px] font-medium text-muted-foreground px-2 py-2 w-8">File</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cardPanelData.matchedPairs.map((pair, pairIdx) => {
                              const { txn, inv } = pair;
                              const children = inv ? childrenByParent.get(inv.id) : undefined;
                              const hasChildren = !!(children && children.length > 0);
                              const isExpanded = inv ? expandedInvoices.has(inv.id) : false;
                              const rowKey = `pair-${pairIdx}-${txn?.transaction_id || ''}-${inv?.id || ''}`;
                              const amtMatch = txn && inv
                                ? Math.abs((txn.amount_hkd ?? txn.amount ?? 0) - invHkd(inv)) < 1.0
                                : false;

                              return [
                                <tr
                                  key={rowKey}
                                  className={`h-9 border-b border-border/50 hover:bg-muted/20 transition-colors ${inv && hasChildren ? 'cursor-pointer' : ''} ${txn && selectedIds.has(txn.transaction_id) ? 'bg-primary/5' : ''} ${inv && selectedInvIds.has(inv.id) ? 'bg-primary/5' : ''}`}
                                  onClick={() => inv && hasChildren && toggleExpandInvoice(inv.id)}
                                >
                                  {/* ===== LEFT: CC TXN ===== */}
                                  <td className="px-2 py-1.5 w-6" onClick={(e) => e.stopPropagation()}>
                                    {txn ? (
                                      <Checkbox checked={selectedIds.has(txn.transaction_id)}
                                        onCheckedChange={() => toggleSelect(txn.transaction_id)} />
                                    ) : null}
                                  </td>
                                  <td className="px-2 py-1.5 text-[11px] tabular-nums whitespace-nowrap">
                                    {txn?.txn_date || <span className="text-muted-foreground/30">—</span>}
                                  </td>
                                  <td className="px-2 py-1.5 text-[11px] font-medium truncate max-w-[160px]" title={txn?.merchant}>
                                    {txn?.merchant || <span className="text-muted-foreground/30 italic">無對應 CC</span>}
                                  </td>
                                  <td className="px-2 py-1.5 text-[11px] text-right tabular-nums font-medium whitespace-nowrap">
                                    {txn ? formatCurrency(txn.amount_hkd ?? txn.amount, txn.amount_hkd != null ? "HKD" : txn.currency) : <span className="text-muted-foreground/30">—</span>}
                                  </td>
                                  {/* Divider cell */}
                                  <td className="w-px bg-border p-0"></td>
                                  {/* ===== RIGHT: INVOICE ===== */}
                                  {inv ? (
                                    <>
                                      <td className="px-2 py-1.5 w-6" onClick={(e) => e.stopPropagation()}>
                                        <Checkbox checked={selectedInvIds.has(inv.id)}
                                          onCheckedChange={() => toggleInvSelect(inv.id)} />
                                      </td>
                                      <td className="px-2 py-1.5 text-[11px] tabular-nums whitespace-nowrap">
                                        <div className="flex items-center gap-1">
                                          {hasChildren ? (
                                            isExpanded ? <ChevronDown size={11} className="text-muted-foreground flex-shrink-0" /> : <ChevronRight size={11} className="text-muted-foreground flex-shrink-0" />
                                          ) : <span className="w-3" />}
                                          {inv.invoice_date || '—'}
                                        </div>
                                      </td>
                                      <td className="px-2 py-1.5 text-[11px] font-medium truncate max-w-[130px]" title={inv.invoice_number ?? undefined}>{inv.invoice_number}</td>
                                      <td className={`px-2 py-1.5 text-[11px] text-right tabular-nums font-semibold whitespace-nowrap ${!amtMatch && txn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                                        <InvAmount inv={inv} />
                                      </td>
                                      <ChildInvoiceFields
                                        child={inv}
                                        projectCodes={projectCodes || []}
                                        expenseCategories={expenseCategories || []}
                                        accountsByEntity={accountsByEntity}
                                        nsDepartments={nsDepartmentsAll}
                                        onUpdate={(patch) => updateInvoiceFieldMutation.mutate({ id: inv.id, patch })}
                                      />
                                      <td className="px-2 py-1.5 text-[11px] text-muted-foreground truncate max-w-[140px]" title={inv.description || ''}>
                                        {inv.description || '—'}
                                        {hasChildren && <span className="ml-1 text-[9px] text-primary/60">({children!.length})</span>}
                                        {(splitsByInvoice.get(inv.id) || []).length > 0 && (
                                          <span className="ml-1 text-[9px] text-primary/60">[{(splitsByInvoice.get(inv.id) || []).length} splits]</span>
                                        )}
                                      </td>
                                      <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                                        {inv.batch_id && batchFileMap.has(inv.batch_id) ? (
                                          <button className="text-primary hover:text-primary/80" title="View original invoice"
                                            onClick={() => openInvoicePdf(inv.batch_id)}>
                                            <ExternalLink size={11} />
                                          </button>
                                        ) : <span className="text-muted-foreground/30">—</span>}
                                      </td>
                                    </>
                                  ) : (
                                    <td colSpan={10} className="px-3 py-1.5 text-[11px] text-muted-foreground/50 italic">無對應 invoice</td>
                                  )}
                                </tr>,
                                // Expanded: split editor spans full width (14 columns)
                                ...(inv && isExpanded ? [
                                  <InvoiceSplitEditor
                                    key={`${inv.id}-editor`}
                                    inv={inv}
                                    splits={splitsByInvoice.get(inv.id) || []}
                                    projectCodes={projectCodes || []}
                                    expenseCategories={expenseCategories || []}
                                        accountsByEntity={accountsByEntity}
                                        nsDepartments={nsDepartmentsAll}
                                    colSpan={15}
                                    onAddSplit={(pc, amt) => addSplitMutation.mutate({
                                      invoiceId: inv.id,
                                      projectCode: pc,
                                      amountHkd: amt,
                                      note: null,
                                      sortOrder: (splitsByInvoice.get(inv.id) || []).length,
                                    })}
                                    onUpdateSplit={(id, patch) => updateSplitMutation.mutate({ id, patch })}
                                    onDeleteSplit={(id) => deleteSplitMutation.mutate(id)}
                                    onUpdateInvoice={(patch) => updateInvoiceFieldMutation.mutate({ id: inv.id, patch })}
                                  />
                                ] : []),
                                // Expanded children appear on the RIGHT half only
                                ...(inv && isExpanded && children ? children.map(child => (
                                  <tr key={child.id} className="bg-muted/10 border-b border-border/30">
                                    <td colSpan={5} className="p-0"></td>
                                    <td className="w-6"></td>
                                    <td className="px-2 py-1 text-[10px] tabular-nums whitespace-nowrap text-muted-foreground pl-4">
                                      {child.invoice_date || '—'}
                                    </td>
                                    <td className="px-2 py-1 text-[10px] text-muted-foreground truncate max-w-[130px]" title={child.invoice_number ?? undefined}>
                                      └ {child.invoice_number}
                                    </td>
                                    <td className="px-2 py-1 text-[10px] text-right tabular-nums text-muted-foreground">
                                      <InvAmount inv={child} />
                                    </td>
                                    <ChildInvoiceFields
                                      child={child}
                                      projectCodes={projectCodes || []}
                                      expenseCategories={expenseCategories || []}
                                        accountsByEntity={accountsByEntity}
                                        nsDepartments={nsDepartmentsAll}
                                      onUpdate={(patch) => updateInvoiceFieldMutation.mutate({ id: child.id, patch })}
                                    />
                                    <td className="px-2 py-1 text-[10px] text-muted-foreground/70 truncate max-w-[140px]" title={child.description || ''}>
                                      {child.description || '—'}
                                    </td>
                                    <td className="px-2 py-1 text-center"><span className="text-muted-foreground/20">—</span></td>
                                  </tr>
                                )) : []),
                              ];
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* ── BOTTOM ROW: UNMATCHED ── */}
              <div>
                <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                  <AlertCircle size={16} className="text-amber-600 dark:text-amber-400" />
                  Unmatched
                </h2>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Bottom-left: Unmatched CC Transactions */}
                  <Card className="border-amber-200 dark:border-amber-800/50">
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground">
                        <CreditCard size={14} />
                        CC Transactions ({cardPanelData.unmatchedTxns.length})
                        <span className="ml-auto tabular-nums">
                          {formatCurrency(cardPanelData.unmatchedTxns.reduce((s, t) => s + (t.amount_hkd ?? t.amount ?? 0), 0))}
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      {cardPanelData.unmatchedTxns.length === 0 ? (
                        <div className="p-6 text-center text-muted-foreground text-xs">All CC entries are matched.</div>
                      ) : (
                        <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                          <table className="w-full table-dense">
                            <thead className="sticky top-0 bg-background">
                              <tr className="border-b border-border bg-muted/30">
                                <th className="px-3 py-2 w-8">
                                  <Checkbox checked={cardPanelData.unmatchedTxns.length > 0 && cardPanelData.unmatchedTxns.every(t => selectedIds.has(t.transaction_id))}
                                    onCheckedChange={() => toggleSelectAll(cardPanelData.unmatchedTxns.map(t => t.transaction_id))} />
                                </th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Date</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Merchant</th>
                                <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2">Amount</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Status</th>
                                <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {cardPanelData.unmatchedTxns.map(txn => (
                                <tr key={txn.transaction_id}
                                  className={`h-8 border-b border-border/50 hover:bg-muted/20 transition-colors ${selectedIds.has(txn.transaction_id) ? 'bg-primary/5' : ''}`}>
                                  <td className="px-3 py-1.5 w-8">
                                    <Checkbox checked={selectedIds.has(txn.transaction_id)}
                                      onCheckedChange={() => toggleSelect(txn.transaction_id)} />
                                  </td>
                                  <td className="px-3 py-1.5 text-xs tabular-nums whitespace-nowrap">{txn.txn_date}</td>
                                  <td className="px-3 py-1.5 text-xs font-medium truncate max-w-[140px]" title={txn.merchant}>{txn.merchant}</td>
                                  <td className="px-3 py-1.5 text-xs text-right tabular-nums font-medium">
                                    {formatCurrency(txn.amount_hkd ?? txn.amount, txn.amount_hkd != null ? "HKD" : txn.currency)}
                                  </td>
                                  <td className="px-3 py-1.5"><StatusBadge status={txn.match_status} /></td>
                                  <td className="px-3 py-1.5 text-right">
                                    <div className="flex gap-1 justify-end">
                                      <Button variant="ghost" size="sm" className="text-xs h-6 px-1.5"
                                        onClick={() => { setSelectedTxn(txn); setModalType("assign"); }}>Assign</Button>
                                      <Button variant="ghost" size="sm" className="text-xs h-6 px-1.5"
                                        onClick={() => { setSelectedTxn(txn); setModalType("split"); }}>Split</Button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Bottom-right: Unmatched Invoices */}
                  <Card className="border-amber-200 dark:border-amber-800/50">
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground">
                        <FileText size={14} />
                        Invoices ({cardPanelData.unmatchedInvs.length})
                        <span className="ml-auto tabular-nums">
                          {formatCurrency(cardPanelData.unmatchedInvs.reduce((s, inv) => s + invHkd(inv), 0))}
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      {cardPanelData.unmatchedInvs.length === 0 ? (
                        <div className="p-6 text-center text-muted-foreground text-xs">All invoices are matched.</div>
                      ) : (
                        <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                          <table className="w-full table-dense">
                            <thead className="sticky top-0 bg-background">
                              <tr className="border-b border-border bg-muted/30">
                                <th className="px-2 py-2 w-6">
                                  <Checkbox
                                    checked={cardPanelData.unmatchedInvs.length > 0 && cardPanelData.unmatchedInvs.every(i => selectedInvIds.has(i.id))}
                                    onCheckedChange={() => selectAllInvs(cardPanelData.unmatchedInvs.map(i => i.id))} />
                                </th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Date</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Invoice #</th>
                                <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2">Amount</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-2 py-2 w-[60px]">Charge To</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-2 py-2 w-[70px]">Project</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-2 py-2 w-[90px]">Account</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-2 py-2 w-[110px]">備註</th>
                                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Description</th>
                                <th className="text-center text-xs font-medium text-muted-foreground px-2 py-2 w-8">File</th>
                              </tr>
                            </thead>
                            <tbody>
                              {cardPanelData.unmatchedInvs.map(inv => {
                                const children = childrenByParent.get(inv.id);
                                const hasChildren = children && children.length > 0;
                                const isExpanded = expandedInvoices.has(inv.id);
                                return [
                                  <tr key={inv.id}
                                    className={`h-8 border-b border-border/50 hover:bg-muted/20 transition-colors ${hasChildren ? 'cursor-pointer' : ''} ${selectedInvIds.has(inv.id) ? 'bg-primary/5' : ''}`}
                                    onClick={() => hasChildren && toggleExpandInvoice(inv.id)}>
                                    <td className="px-2 py-1.5 w-6" onClick={(e) => e.stopPropagation()}>
                                      <Checkbox checked={selectedInvIds.has(inv.id)}
                                        onCheckedChange={() => toggleInvSelect(inv.id)} />
                                    </td>
                                    <td className="px-3 py-1.5 text-xs tabular-nums whitespace-nowrap">
                                      <div className="flex items-center gap-1">
                                        {hasChildren ? (
                                          isExpanded ? <ChevronDown size={12} className="text-muted-foreground flex-shrink-0" /> : <ChevronRight size={12} className="text-muted-foreground flex-shrink-0" />
                                        ) : <span className="w-3" />}
                                        {inv.invoice_date || '—'}
                                      </div>
                                    </td>
                                    <td className="px-3 py-1.5 text-xs font-medium truncate max-w-[140px]" title={inv.invoice_number ?? undefined}>{inv.invoice_number}</td>
                                    <td className="px-3 py-1.5 text-xs text-right tabular-nums font-semibold">
                                      <InvAmount inv={inv} />
                                    </td>
                                    <ChildInvoiceFields
                                      child={inv}
                                      projectCodes={projectCodes || []}
                                      expenseCategories={expenseCategories || []}
                                        accountsByEntity={accountsByEntity}
                                        nsDepartments={nsDepartmentsAll}
                                      onUpdate={(patch) => updateInvoiceFieldMutation.mutate({ id: inv.id, patch })}
                                    />
                                    <td className="px-3 py-1.5 text-xs text-muted-foreground truncate max-w-[140px]" title={inv.description || ''}>
                                      {inv.description || '—'}
                                      {hasChildren && <span className="ml-1 text-[10px] text-primary/60">({children.length} items)</span>}
                                      {(splitsByInvoice.get(inv.id) || []).length > 0 && (
                                        <span className="ml-1 text-[10px] text-primary/60">[{(splitsByInvoice.get(inv.id) || []).length} splits]</span>
                                      )}
                                    </td>
                                    <td className="px-2 py-1.5 text-center">
                                      {inv.batch_id && batchFileMap.has(inv.batch_id) ? (
                                        <button className="text-primary hover:text-primary/80" title="View original invoice"
                                          onClick={(e) => { e.stopPropagation(); openInvoicePdf(inv.batch_id); }}>
                                          <ExternalLink size={12} />
                                        </button>
                                      ) : <span className="text-muted-foreground/30">—</span>}
                                    </td>
                                  </tr>,
                                  ...(isExpanded ? [
                                    <InvoiceSplitEditor
                                      key={`${inv.id}-editor`}
                                      inv={inv}
                                      splits={splitsByInvoice.get(inv.id) || []}
                                      projectCodes={projectCodes || []}
                                      expenseCategories={expenseCategories || []}
                                        accountsByEntity={accountsByEntity}
                                        nsDepartments={nsDepartmentsAll}
                                      colSpan={10}
                                      onAddSplit={(pc, amt) => addSplitMutation.mutate({
                                        invoiceId: inv.id,
                                        projectCode: pc,
                                        amountHkd: amt,
                                        note: null,
                                        sortOrder: (splitsByInvoice.get(inv.id) || []).length,
                                      })}
                                      onUpdateSplit={(id, patch) => updateSplitMutation.mutate({ id, patch })}
                                      onDeleteSplit={(id) => deleteSplitMutation.mutate(id)}
                                      onUpdateInvoice={(patch) => updateInvoiceFieldMutation.mutate({ id: inv.id, patch })}
                                    />
                                  ] : []),
                                  ...(isExpanded && children ? children.map(child => (
                                    <tr key={child.id} className="bg-muted/10 border-b border-border/30">
                                      <td className="w-6"></td>
                                      <td className="px-3 py-1 text-[11px] tabular-nums whitespace-nowrap text-muted-foreground pl-8">
                                        {child.invoice_date || '—'}
                                      </td>
                                      <td className="px-3 py-1 text-[11px] text-muted-foreground truncate max-w-[140px]" title={child.invoice_number ?? undefined}>
                                        └ {child.invoice_number}
                                      </td>
                                      <td className="px-3 py-1 text-[11px] text-right tabular-nums text-muted-foreground">
                                        <InvAmount inv={child} />
                                      </td>
                                      <ChildInvoiceFields
                                        child={child}
                                        projectCodes={projectCodes || []}
                                        expenseCategories={expenseCategories || []}
                                        accountsByEntity={accountsByEntity}
                                        nsDepartments={nsDepartmentsAll}
                                        onUpdate={(patch) => updateInvoiceFieldMutation.mutate({ id: child.id, patch })}
                                      />
                                      <td className="px-3 py-1 text-[11px] text-muted-foreground/70 truncate max-w-[140px]" title={child.description || ''}>
                                        {child.description || '—'}
                                      </td>
                                      <td className="px-2 py-1 text-center"><span className="text-muted-foreground/20">—</span></td>
                                    </tr>
                                  )) : []),
                                ];
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* Modals */}
      {selectedTxn && modalType === "assign" && (
        <AssignModal transaction={selectedTxn} onClose={handleModalClose} onSaved={handleModalSaved} />
      )}
      {selectedTxn && modalType === "split" && (
        <SplitModal transaction={selectedTxn} onClose={handleModalClose} onSaved={handleModalSaved} />
      )}

      {/* Sticky Bulk Action Bar */}
      {selectedInvIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg">
          <div className="flex items-center justify-between px-6 py-3 max-w-screen-2xl mx-auto">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{selectedInvIds.size} 條 invoice 已選取</span>
              <ManualPairButton />
              {Array.from(selectedInvIds).filter(id => matchedInvoiceIds.has(id)).length > 0 && (
                <Button variant="outline" size="sm" className="text-xs h-7"
                  disabled={unmatchMutation.isPending}
                  onClick={() => unmatchMutation.mutate({ invoiceIds: Array.from(selectedInvIds) })}
                  data-testid="button-unmatch-invoices"
                  title="解除配對，將發票同對應交易退回 Unmatched（唔會刪除資料）">
                  {unmatchMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Unlink className="h-3 w-3 mr-1" />}
                  解除配對
                </Button>
              )}
              {!confirmInvDelete ? (
                <Button variant="destructive" size="sm" className="text-xs h-7"
                  onClick={() => setConfirmInvDelete(true)} data-testid="button-delete-invoices">
                  <Trash2 className="h-3 w-3 mr-1" /> 刪除 invoice
                </Button>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-destructive">確認刪除 {selectedInvIds.size} 張？（連上載紀錄一齊清）</span>
                  <Button variant="destructive" size="sm" className="text-xs h-7"
                    disabled={deleteInvoicesMutation.isPending}
                    onClick={() => { deleteInvoicesMutation.mutate(Array.from(selectedInvIds)); setConfirmInvDelete(false); }}
                    data-testid="button-confirm-delete-invoices">
                    {deleteInvoicesMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    確認刪除
                  </Button>
                  <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setConfirmInvDelete(false)}>取消</Button>
                </span>
              )}
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { setSelectedInvIds(new Set()); setConfirmInvDelete(false); }}>
                取消選取
              </Button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Charge To:</span>
              <Select value={bulkEntity || undefined} onValueChange={setBulkEntity}>
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue placeholder="選擇公司" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SSHK">SSHK — Social Strategy Hong Kong Limited</SelectItem>
                  <SelectItem value="PBHK">PBHK — Photoblog.hk Limited</SelectItem>
                  <SelectItem value="CLS">CLS — CLS Production Limited</SelectItem>
                  <SelectItem value="JM">JM — Jervois M Limited</SelectItem>
                  <SelectItem value="704">704 — 704 Production Limited</SelectItem>
                  <SelectItem value="EXT">EXT — ExtravelIsm</SelectItem>
                  <SelectItem value="JS">JS — Jervois Solution</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8" disabled={!bulkEntity || bulkUpdateEntity.isPending}
                onClick={() => bulkUpdateEntity.mutate()}>
                {bulkUpdateEntity.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                套用
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
