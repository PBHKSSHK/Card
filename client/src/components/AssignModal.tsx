import { useState, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/components/StatusBadge";
import { formatCategoryLabel } from "@/lib/utils";
import { Loader2, Search, X } from "lucide-react";
import type { TransactionFull, ExpenseCategory, MetaInvoice, NsProjectCode } from "@shared/schema";
import { projectMatchesEntity } from "@shared/schema";
import { useNoLedgerEntities } from "@/hooks/use-no-ledger-entities";

interface Props {
  transaction: TransactionFull;
  onClose: () => void;
  onSaved: () => void;
}

interface NsDepartment {
  id: string;
  entity_code: string;
  charge_to: string;
  name: string;
  subsidiary_name: string;
  ns_subsidiary: string;
  is_active: boolean;
}

export default function AssignModal({ transaction, onClose, onSaved }: Props) {
  const [entityCode, setEntityCode] = useState("");
  const [chargeTo, setChargeTo] = useState("");
  const [expenseCategory, setExpenseCategory] = useState<string>("");
  const [projectCode, setProjectCode] = useState<string>("");
  const [note, setNote] = useState("");
  const [saveAsRule, setSaveAsRule] = useState(false);
  const [linkedInvoice, setLinkedInvoice] = useState<MetaInvoice | null>(null);
  const [invSearch, setInvSearch] = useState("");
  const [showAllMonths, setShowAllMonths] = useState(false);
  const { toast } = useToast();

  // Load NetSuite departments (entity + charge_to + dept name)
  const { data: nsDepartments = [] } = useQuery<NsDepartment[]>({
    queryKey: ["ns_departments_assign"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_departments")
        .select("*")
        .eq("is_active", true)
        .order("entity_code")
        .order("charge_to");
      if (error) throw error;
      return data as NsDepartment[];
    },
  });

  // Load expense categories (so user can pick GL account)
  const { data: expenseCategories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ["expense_categories_assign"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("*")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return data as ExpenseCategory[];
    },
  });

  // Load NetSuite project codes (for the Project Code picker)
  const { data: projectCodes = [] } = useQuery<NsProjectCode[]>({
    queryKey: ["ns_project_codes_assign"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_project_codes")
        .select("*")
        .order("project_id");
      if (error) throw error;
      return data as NsProjectCode[];
    },
  });

  // JS / Go Asia etc. — no independent NetSuite ledger, Category not asked for.
  const noLedgerEntities = useNoLedgerEntities();

  // Load unmatched invoices (preferably same month)
  const txnMonth = transaction.txn_date?.slice(0, 7); // YYYY-MM
  const { data: unmatchedInvoices = [] } = useQuery<MetaInvoice[]>({
    queryKey: ["unmatched_invoices_for_assign", showAllMonths, txnMonth],
    queryFn: async () => {
      let q = supabase
        .from("meta_invoices")
        .select("*")
        .eq("is_matched", false)
        .is("parent_invoice_id", null) // only top-level
        .order("invoice_date", { ascending: false })
        .limit(200);
      if (!showAllMonths && txnMonth) {
        // Window: same month +/- 1 month tolerance
        const [y, m] = txnMonth.split("-").map(Number);
        const start = new Date(y, m - 2, 1).toISOString().slice(0, 10);
        const end = new Date(y, m + 1, 0).toISOString().slice(0, 10);
        q = q.gte("invoice_date", start).lte("invoice_date", end);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as MetaInvoice[];
    },
  });

  // Distinct entity list from ns_departments
  const entities = useMemo(() => {
    const map = new Map<string, { code: string; subsidiary: string }>();
    nsDepartments.forEach(d => {
      if (!map.has(d.entity_code)) {
        map.set(d.entity_code, { code: d.entity_code, subsidiary: d.subsidiary_name });
      }
    });
    return Array.from(map.values());
  }, [nsDepartments]);

  // Filter departments by selected entity
  const filteredDepts = useMemo(
    () => nsDepartments.filter(d => d.entity_code === entityCode),
    [nsDepartments, entityCode]
  );

  const selectedCategory = expenseCategories.find(c => c.category_key === expenseCategory);
  const selectedProject = projectCodes.find(p => p.project_id === projectCode);

  // Projects filtered by the picked entity (fallback to all if none match, so
  // the user is never stuck — mirrors ReconQueue behaviour for EXT/JS).
  const filteredProjects = useMemo(() => {
    const matched = projectCodes.filter(p => projectMatchesEntity(p, entityCode || null));
    return matched.length > 0 ? matched : projectCodes;
  }, [projectCodes, entityCode]);

  // req: Category depends on whether a Project Code is chosen —
  // project selected → only [Project] categories (account 7xxxx);
  // no project → only non-[Project] categories.
  const isProjectCat = (c: ExpenseCategory) => (c.ns_account_number || "").startsWith("7");
  const filteredCategories = useMemo(
    () => (projectCode ? expenseCategories.filter(isProjectCat) : expenseCategories.filter(c => !isProjectCat(c))),
    [expenseCategories, projectCode]
  );

  // Filter invoices by search
  const filteredInvoices = useMemo(() => {
    if (linkedInvoice) return []; // hide picker once linked
    const term = invSearch.trim().toLowerCase();
    const txnAmt = Number(transaction.amount_hkd ?? transaction.amount) || 0;
    let list = unmatchedInvoices;
    if (term) {
      list = list.filter(inv =>
        (inv.invoice_number || "").toLowerCase().includes(term) ||
        (inv.account_name || "").toLowerCase().includes(term) ||
        (inv.description || "").toLowerCase().includes(term) ||
        String(inv.amount_hkd || "").includes(term) ||
        String(inv.amount || "").includes(term)
      );
    }
    // Sort: amount-close first, then date-close
    const scored = list.map(inv => {
      const invAmt = Number(inv.amount_hkd ?? inv.amount) || 0;
      const amtDiff = txnAmt > 0 ? Math.abs(invAmt - txnAmt) / Math.max(txnAmt, invAmt) : 1;
      const dayDiff = inv.invoice_date && transaction.txn_date
        ? Math.abs(new Date(inv.invoice_date).getTime() - new Date(transaction.txn_date).getTime()) / 86400000
        : 999;
      return { inv, score: amtDiff * 100 + dayDiff };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 50).map(s => s.inv);
  }, [unmatchedInvoices, invSearch, linkedInvoice, transaction]);

  const assignMutation = useMutation({
    mutationFn: async () => {
      const dept = nsDepartments.find(d => d.charge_to === chargeTo);
      if (!dept) throw new Error("Department not found");

      // Update card_transactions row directly with assignment metadata
      const { error: txnError } = await supabase
        .from("card_transactions")
        .update({
          assigned_entity_code: dept.entity_code,
          assigned_charge_to: dept.charge_to,
          assigned_subsidiary: dept.subsidiary_name,
          assigned_dept_name: dept.name,
          assigned_expense_category: expenseCategory || null,
          assigned_ns_account_number: selectedCategory?.ns_account_number || null,
          assigned_ns_account_name: selectedCategory?.label_en || null,
          assigned_note: note || null,
          assigned_at: new Date().toISOString(),
        })
        .eq("id", transaction.transaction_id);
      if (txnError) throw txnError;

      // ⭐ FIX: JournalExport reads accounting_lines (ns_* columns), NOT the
      // assigned_* columns written above — so a manual assignment never reached
      // the NetSuite journal. Upsert an accounting_lines row mirroring the exact
      // column shape JournalExport/ReconQueue use so the assignment actually exports.
      const lineAmountHkd = Number(transaction.amount_hkd ?? transaction.amount);
      const linePayload: Record<string, any> = {
        transaction_id: transaction.transaction_id,
        amount_hkd: lineAmountHkd,
        split_pct: 100,
        ns_entity_code: dept.entity_code,
        ns_charge_to: dept.charge_to,
        ns_subsidiary_name: dept.subsidiary_name,
        ns_dept_name: dept.name,
        ns_account_number: selectedCategory?.ns_account_number || null,
        ns_account_name: selectedCategory?.label_en || null,
        ns_project_code: selectedProject?.project_id || null,
        ns_project_name: selectedProject?.project_name || null,
        ns_customer_name: selectedProject?.customer_name || null,
        // dr_account is NOT NULL in accounting_lines (legacy column). SplitModal and the
        // matching engine both set it; Assign omitted it, so every Assign hit a not-null
        // violation ("null value in column dr_account"). Mirror SplitModal: use the picked
        // GL account, else the '6000' fallback. cr_account set for the same consistency.
        dr_account: selectedCategory?.ns_account_number || '6000',
        cr_account: '2100',
        description: note || transaction.merchant || null,
      };

      // Replace ANY existing accounting_lines for this txn with a single 100% line.
      // The txn may already have MULTIPLE lines (if it was previously split), so a
      // maybeSingle() lookup would error and we'd stack a duplicate DR on top of the
      // split → double-counted expense. Delete-then-insert guarantees exactly one line.
      const { error: delErr } = await supabase
        .from("accounting_lines")
        .delete()
        .eq("transaction_id", transaction.transaction_id);
      if (delErr) throw delErr;
      const { data: alIns, error: alErr } = await supabase
        .from("accounting_lines")
        .insert(linePayload)
        .select();
      if (alErr) throw alErr;
      if (!alIns || alIns.length === 0) throw new Error("Accounting line insert affected 0 rows (RLS?)");

      // Upsert reconciliation_results row marking it manual
      const { data: existing } = await supabase
        .from("reconciliation_results")
        .select("id")
        .eq("transaction_id", transaction.transaction_id)
        .maybeSingle();

      const payload: any = {
        transaction_id: transaction.transaction_id,
        invoice_id: linkedInvoice?.id || null,
        status: 'matched',
        match_type: 'manual',
        confidence: 100,
        matched_at: new Date().toISOString(),
        matched_by: 'user',
        notes: `Manual assign → ${dept.entity_code} / ${dept.charge_to} / ${dept.name}${expenseCategory ? ' / ' + (selectedCategory?.label_en ?? expenseCategory) : ''}${projectCode ? ' / ' + projectCode : ''}${linkedInvoice ? ' · inv ' + linkedInvoice.invoice_number : ''}${note ? ' · ' + note : ''}`,
      };

      if (existing?.id) {
        const { data: upd, error } = await supabase
          .from("reconciliation_results")
          .update(payload)
          .eq("id", existing.id)
          .select();
        if (error) throw error;
        if (!upd || upd.length === 0) throw new Error("Update affected 0 rows (RLS?)");
      } else {
        const { data: ins, error } = await supabase
          .from("reconciliation_results")
          .insert(payload)
          .select();
        if (error) throw error;
        if (!ins || ins.length === 0) throw new Error("Insert affected 0 rows (RLS?)");
      }

      // Mark invoice as matched. Also overwrite invoice.amount_hkd with the
      // bank's actual HKD charge — the CC statement is the source of truth
      // for what got billed in HKD. We do NOT recompute fx_rate; the bank's
      // figure already bakes in their FX + fees.
      if (linkedInvoice?.id) {
        const bankHkd = Number(transaction.amount_hkd ?? transaction.amount);
        const invoicePatch: Record<string, any> = { is_matched: true };
        if (bankHkd && bankHkd > 0) {
          invoicePatch.amount_hkd = bankHkd;
        }
        const { data: invUpd, error: invErr } = await supabase
          .from("meta_invoices")
          .update(invoicePatch)
          .eq("id", linkedInvoice.id)
          .select();
        if (invErr) throw invErr;
        if (!invUpd || invUpd.length === 0) throw new Error("Invoice update affected 0 rows (RLS?)");
      }

      // Save as matching rule (auto-apply same merchant in future)
      if (saveAsRule) {
        const merchantKey = (transaction.merchant || "").trim().toUpperCase().split(/\s+/)[0];
        if (merchantKey) {
          await supabase.from("matching_rules").insert({
            keyword: merchantKey + '*',
            target_entity: dept.entity_code,
            dept_code: dept.charge_to,
            priority: 20,
            is_active: true,
            module: 'card',
          });
        }
      }
    },
    onSuccess: () => {
      toast({ title: "已分派", description: linkedInvoice ? `已配對 ${linkedInvoice.invoice_number}` : "Transaction assigned" });
      onSaved();
    },
    onError: (err: Error) => {
      toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Assign Transaction</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="bg-muted/50 rounded-md p-3 space-y-1">
            <p className="text-sm font-medium">{transaction.merchant}</p>
            <p className="text-sm text-muted-foreground">
              {transaction.txn_date} · {formatCurrency(transaction.amount_hkd ?? transaction.amount, transaction.currency)}
            </p>
          </div>

          {/* Journal hint — Assign is the authoritative correction path: it overwrites the
              txn's accounting_lines, which the journal reads before any invoice fallback. */}
          <p className="text-[11px] leading-snug text-muted-foreground -mt-1">
            💡 Assign 會覆蓋此交易現有分錄並直接寫入 journal（Subsidiary / Department / Account 以此為準）。Export CSV 後發現分錯公司／部門／科目，喺呢度改完再重新 Export 即可。
          </p>

          {/* Link Invoice */}
          <div className="space-y-2 border rounded-md p-3 bg-blue-50/30">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">配對 Invoice (可選)</Label>
              {!linkedInvoice && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAllMonths(!showAllMonths)}
                >
                  {showAllMonths ? "← 只睇近期月份" : "顯示所有月份 →"}
                </button>
              )}
            </div>
            {linkedInvoice ? (
              <div className="flex items-center justify-between bg-white rounded p-2 border">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{linkedInvoice.invoice_number}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {linkedInvoice.invoice_date} · {formatCurrency(linkedInvoice.amount_hkd ?? linkedInvoice.amount, linkedInvoice.currency || "HKD")}
                    {linkedInvoice.account_name ? ` · ${linkedInvoice.account_name}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="ml-2 text-muted-foreground hover:text-destructive"
                  onClick={() => setLinkedInvoice(null)}
                  data-testid="unlink-invoice"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={invSearch}
                    onChange={(e) => setInvSearch(e.target.value)}
                    placeholder="搜尋 invoice number / 名稱 / 金額"
                    className="pl-8 text-sm"
                    data-testid="invoice-search"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto border rounded bg-white">
                  {filteredInvoices.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-3 text-center">
                      {unmatchedInvoices.length === 0 ? "冇 unmatched invoice" : "冇 match 條件嘅 invoice"}
                    </div>
                  ) : (
                    filteredInvoices.map(inv => {
                      const invAmt = Number(inv.amount_hkd ?? inv.amount) || 0;
                      const txnAmt = Number(transaction.amount_hkd ?? transaction.amount) || 0;
                      const amtClose = txnAmt > 0 && Math.abs(invAmt - txnAmt) / Math.max(txnAmt, invAmt) < 0.05;
                      return (
                        <button
                          key={inv.id}
                          type="button"
                          onClick={() => setLinkedInvoice(inv)}
                          className="w-full text-left p-2 hover:bg-muted/50 border-b last:border-b-0 text-xs"
                          data-testid={`pick-invoice-${inv.id}`}
                        >
                          <div className="flex justify-between gap-2">
                            <span className="font-medium truncate flex-1">{inv.invoice_number}</span>
                            <span className={amtClose ? "text-green-700 font-semibold" : ""}>
                              {formatCurrency(inv.amount_hkd ?? inv.amount, inv.currency || "HKD")}
                            </span>
                          </div>
                          <div className="text-muted-foreground truncate">
                            {inv.invoice_date} · {inv.account_name || inv.description || "—"}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>

          {/* 公司 (Entity) */}
          <div className="space-y-2">
            <Label className="text-sm">公司 (Entity)</Label>
            <Select
              value={entityCode || undefined}
              onValueChange={(v) => {
                setEntityCode(v);
                setChargeTo("");
                setExpenseCategory("");
                // Keep the project only if it still matches the new entity
                const curProj = projectCodes.find(p => p.project_id === projectCode);
                if (curProj && !projectMatchesEntity(curProj, v)) setProjectCode("");
              }}
            >
              <SelectTrigger data-testid="select-entity">
                <SelectValue placeholder="揀公司 / Select entity" />
              </SelectTrigger>
              <SelectContent>
                {entities.map(e => (
                  <SelectItem key={e.code} value={e.code}>
                    {e.code} — {e.subsidiary}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Department (charge_to) */}
          <div className="space-y-2">
            <Label className="text-sm">Department / Charge To</Label>
            <Select value={chargeTo || undefined} onValueChange={setChargeTo} disabled={!entityCode}>
              <SelectTrigger data-testid="select-department">
                <SelectValue placeholder={entityCode ? "揀部門 / Select department" : "先揀公司"} />
              </SelectTrigger>
              <SelectContent>
                {filteredDepts.map(d => (
                  <SelectItem key={d.id} value={d.charge_to}>
                    {d.charge_to} — {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Project Code — above Category; picking one restricts Category to [Project] items */}
          <div className="space-y-2">
            <Label className="text-sm">Project Code (可選)</Label>
            <Select
              value={projectCode || "__none__"}
              onValueChange={(v) => {
                const next = v === "__none__" ? "" : v;
                setProjectCode(next);
                // Category set depends on project selection — drop a pick that no longer fits
                if (selectedCategory && (!!next !== isProjectCat(selectedCategory))) {
                  setExpenseCategory("");
                }
              }}
            >
              <SelectTrigger data-testid="select-project">
                <SelectValue placeholder="揀 project（可選）" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="__none__">— No project —</SelectItem>
                {filteredProjects.map(p => (
                  <SelectItem key={p.id} value={p.project_id}>
                    {p.project_id} · {p.project_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Expense Category — skipped for JS / Go Asia (no independent NetSuite ledger).
              Options depend on Project: with project → [Project] (7xxxx) only; without → non-[Project] only. */}
          <div className="space-y-2">
            <Label className="text-sm">Category (NetSuite Account)</Label>
            {entityCode && noLedgerEntities.has(entityCode) ? (
              <div className="text-[12px] text-muted-foreground rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 leading-snug" data-testid="no-ledger-note">
                {entityCode} 喺 NetSuite 冇獨立 ledger — <span className="font-medium text-foreground">唔使揀 Category</span>。Journal 只會出「Due From」（AR）過 Photoblog。
              </div>
            ) : (
              <Select value={expenseCategory || undefined} onValueChange={setExpenseCategory}>
                <SelectTrigger data-testid="select-category">
                  <SelectValue placeholder={projectCode ? "揀 [Project] category" : "揀 category（用嚟出 journal）"} />
                </SelectTrigger>
                <SelectContent>
                  {filteredCategories.map(c => (
                    <SelectItem key={c.category_key} value={c.category_key}>
                      {formatCategoryLabel(c.label_zh, c.ns_account_number)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Note */}
          <div className="space-y-2">
            <Label className="text-sm">備註 (Note)</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional note"
              data-testid="input-note"
            />
          </div>

          <div className="flex items-center space-x-2 pt-1">
            <Checkbox
              id="save-rule"
              checked={saveAsRule}
              onCheckedChange={(v) => setSaveAsRule(!!v)}
              data-testid="checkbox-save-rule"
            />
            <Label htmlFor="save-rule" className="text-sm text-muted-foreground cursor-pointer">
              Save as matching rule（將來同類 merchant 自動分派）
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => assignMutation.mutate()}
            disabled={!entityCode || !chargeTo || assignMutation.isPending}
            data-testid="button-confirm-assign"
          >
            {assignMutation.isPending ? <Loader2 className="animate-spin mr-2" size={16} /> : null}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
