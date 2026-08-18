import { useState, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/components/StatusBadge";
import { formatCategoryLabel } from "@/lib/utils";
import { round2, sum2 } from "@/lib/money";
import { Plus, Trash2, Loader2, AlertCircle } from "lucide-react";
import type { TransactionFull, ExpenseCategory, NsProjectCode } from "@shared/schema";
import { projectMatchesEntity } from "@shared/schema";
import { useNoLedgerEntities } from "@/hooks/use-no-ledger-entities";

interface NsDepartment {
  id: string;
  entity_code: string;
  charge_to: string;
  name: string;
  subsidiary_name: string;
  ns_subsidiary: string;
  is_active: boolean;
}

interface SplitLine {
  entityCode: string;       // ns_departments.entity_code (eg "PBHK")
  chargeTo: string;         // ns_departments.charge_to  (eg "PB-AccSer")
  expenseCategory: string;  // expense_categories.category_key
  projectCode: string;      // ns_project_codes.project_id (eg "P10000119")
  amount: number;
  pct: number;
  // 備註 — 有填就寫入 accounting_lines.description，journal line memo 直接用佢
  // （取代 Upload Centre 嘅 invoice 備註）；留空則 journal fallback 用返 invoice 備註。
  note: string;
}

interface Props {
  transaction: TransactionFull;
  onClose: () => void;
  onSaved: () => void;
}

export default function SplitModal({ transaction, onClose, onSaved }: Props) {
  // Coerce — numeric columns can surface as strings depending on the driver;
  // a string here would break every amount computation (string concat) and
  // permanently disable Save via isBalanced.
  const totalAmount = Number(transaction.amount_hkd ?? transaction.amount) || 0;
  const [lines, setLines] = useState<SplitLine[]>([
    { entityCode: "", chargeTo: "", expenseCategory: "", projectCode: "", amount: totalAmount, pct: 100, note: "" },
  ]);
  const { toast } = useToast();

  // JS / Go Asia etc. — no independent NetSuite ledger, so no Category is asked
  // for those lines (journal only books a "Due From" AR).
  const noLedgerEntities = useNoLedgerEntities();

  // Load NetSuite departments (entity + charge_to + dept name)
  const { data: nsDepartments = [] } = useQuery<NsDepartment[]>({
    queryKey: ["ns_departments_split"],
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

  // Load expense categories
  const { data: expenseCategories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ["expense_categories_split"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("*")
        .eq("is_active", true)
        .eq("admin_only", false) // 8100 admin a/c 只喺供應商付款申請用
        .order("sort_order");
      if (error) throw error;
      return data as ExpenseCategory[];
    },
  });

  // Load NetSuite project codes
  const { data: projectCodes = [] } = useQuery<NsProjectCode[]>({
    queryKey: ["ns_project_codes_split"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_project_codes")
        .select("*")
        .order("project_id");
      if (error) throw error;
      return data as NsProjectCode[];
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

  const addLine = () => {
    setLines([...lines, { entityCode: "", chargeTo: "", expenseCategory: "", projectCode: "", amount: 0, pct: 0, note: "" }]);
  };

  const removeLine = (index: number) => {
    if (lines.length <= 1) return;
    setLines(lines.filter((_, i) => i !== index));
  };

  const updateLine = (index: number, field: keyof SplitLine, value: any) => {
    const updated = [...lines];
    updated[index] = { ...updated[index], [field]: value };

    if (field === "pct") {
      // Clamp % -> amount to 2dp (avoid sub-cent drift)
      updated[index].amount = round2(totalAmount * (Number(value) / 100));
    } else if (field === "amount") {
      // Clamp typed amount to 2dp; derive % from the rounded amount
      const amt = round2(Number(value));
      updated[index].amount = amt;
      updated[index].pct = totalAmount ? round2((amt / totalAmount) * 100) : 0;
    } else if (field === "entityCode") {
      // Reset dept + project when entity changes (project may not match new entity)
      updated[index].chargeTo = "";
      const curProj = projectCodes.find(p => p.project_id === updated[index].projectCode);
      if (curProj && !projectMatchesEntity(curProj, value)) {
        updated[index].projectCode = "";
      }
      // No-ledger entity (JS / Go Asia) — Category doesn't apply, clear any pick
      if (noLedgerEntities.has(value)) {
        updated[index].expenseCategory = "";
      }
    } else if (field === "projectCode") {
      // Category set depends on project selection ([Project] 7xxxx vs overhead) —
      // drop a previously-picked category that no longer fits.
      const cat = expenseCategories.find(c => c.category_key === updated[index].expenseCategory);
      if (cat && (!!value !== (cat.ns_account_number || "").startsWith("7"))) {
        updated[index].expenseCategory = "";
      }
    }

    setLines(updated);
  };

  // req: with a Project Code → only [Project] categories (account 7xxxx);
  // without → only non-[Project] categories. Same rule as Upload Centre / Assign.
  const isProjectCat = (c: ExpenseCategory) => (c.ns_account_number || "").startsWith("7");

  const totalSplit = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const isBalanced = Math.abs(totalSplit - totalAmount) < 0.01;
  const allComplete = lines.every(l => l.entityCode && l.chargeTo && (Number(l.amount) || 0) > 0);

  // 講明點解 Save 被鎖 — 唔好靜靜哋 disabled
  const disabledReasons: string[] = [];
  if (!isBalanced) disabledReasons.push(`金額未平（差 ${round2(totalAmount - totalSplit).toFixed(2)}）`);
  lines.forEach((l, i) => {
    const missing: string[] = [];
    if (!l.entityCode) missing.push("Entity");
    if (!l.chargeTo) missing.push("Department/Team");
    if (!((Number(l.amount) || 0) > 0)) missing.push("Amount");
    if (missing.length) disabledReasons.push(`Line ${i + 1} 未填：${missing.join("、")}`);
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Delete ALL existing accounting_lines for this txn FIRST — and CHECK the error.
      // If this delete silently fails (RLS/network) while the inserts below succeed, the
      // txn ends up with old lines + new lines = doubled DR expense. The journal computes
      // the credit-card CR from the txn total ONCE, so a doubled DR leaves that company's
      // journal unbalanced. Fail loudly here so old records are always cleared first.
      const { error: delErr } = await supabase
        .from("accounting_lines")
        .delete()
        .eq("transaction_id", transaction.transaction_id);
      if (delErr) throw delErr;

      // Round each split to 2dp and give the LAST line the remainder so the
      // split sums EXACTLY to the original amount (no lost/gained sub-cents).
      const normalizedLines = lines.map((l, i) => {
        if (i === lines.length - 1) {
          const othersTotal = sum2(lines.slice(0, -1).map(o => round2(o.amount)));
          return { ...l, amount: round2(totalAmount - othersTotal) };
        }
        return { ...l, amount: round2(l.amount) };
      });

      // Insert new lines
      for (const line of normalizedLines) {
        const dept = nsDepartments.find(d => d.entity_code === line.entityCode && d.charge_to === line.chargeTo);
        if (!dept) throw new Error(`Department not found for ${line.entityCode}/${line.chargeTo}`);
        const cat = expenseCategories.find(c => c.category_key === line.expenseCategory);
        const proj = projectCodes.find(p => p.project_id === line.projectCode);
        const { error } = await supabase.from("accounting_lines").insert({
          transaction_id: transaction.transaction_id,
          ns_entity_code: dept.entity_code,
          ns_charge_to: dept.charge_to,
          ns_subsidiary_name: dept.subsidiary_name,
          ns_dept_name: dept.name,
          ns_account_number: cat?.ns_account_number || null,
          ns_account_name: cat?.label_en || null,
          expense_category: line.expenseCategory || null,
          ns_project_code: proj?.project_id || null,
          ns_project_name: proj?.project_name || null,
          ns_customer_name: proj?.customer_name || null,
          amount_hkd: line.amount,
          split_pct: line.pct,
          dr_account: cat?.ns_account_number || '6000',
          cr_account: '2100',
          // 備註有填 → journal line memo 用佢（取代 Upload Centre 備註）；
          // 留空 → 存 merchant，JournalExport 會 fallback 用返 invoice 備註。
          description: (line.note || "").trim() || transaction.merchant,
        });
        if (error) {
          // RLS rejection reads cryptically — translate the common case.
          if (/row-level security/i.test(error.message)) {
            throw new Error(`你嘅帳號冇權將數拆去 ${line.entityCode}（BU 用戶只可以拆去自己有權嘅公司）。請搵 admin 處理。`);
          }
          throw error;
        }
      }

      // Update reconciliation result — check the error too, so a silent RLS/network
      // failure doesn't leave the txn's status out of sync with its freshly-written lines.
      const { error: rrErr } = await supabase
        .from("reconciliation_results")
        .update({
          status: 'manual',
          match_type: 'split',
          confidence: 100,
          matched_at: new Date().toISOString(),
          matched_by: 'user',
          notes: `Split into ${lines.length} lines`,
        })
        .eq("transaction_id", transaction.transaction_id);
      if (rrErr) throw rrErr;
    },
    onSuccess: () => {
      toast({ title: "Split saved", description: `${lines.length} lines created` });
      onSaved();
    },
    onError: (err: Error) => {
      toast({ title: "Split failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Split Transaction</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="bg-muted/50 rounded-md p-3 space-y-1">
            <p className="text-sm font-medium">{transaction.merchant}</p>
            <p className="text-sm text-muted-foreground">
              {transaction.txn_date} · Total: {formatCurrency(totalAmount, transaction.currency)}
            </p>
          </div>

          {/* Split lines */}
          <div className="space-y-3">
            {lines.map((line, i) => {
              const filteredDepts = nsDepartments.filter(d => d.entity_code === line.entityCode);
              const filteredProjects = projectCodes.filter(p => projectMatchesEntity(p, line.entityCode || null));
              return (
                <div key={i} className="border border-border rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Line {i + 1}</span>
                    {lines.length > 1 && (
                      <Button variant="ghost" size="sm" onClick={() => removeLine(i)} className="h-6 px-1.5">
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Entity</Label>
                      <Select value={line.entityCode || undefined} onValueChange={v => updateLine(i, "entityCode", v)}>
                        <SelectTrigger className="h-8 text-sm" data-testid={`split-entity-${i}`}>
                          <SelectValue placeholder="Entity" />
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
                    <div>
                      <Label className="text-xs">Department / Team</Label>
                      <Select
                        value={line.chargeTo || undefined}
                        onValueChange={v => updateLine(i, "chargeTo", v)}
                        disabled={!line.entityCode}
                      >
                        <SelectTrigger className="h-8 text-sm" data-testid={`split-dept-${i}`}>
                          <SelectValue placeholder={line.entityCode ? "Select team..." : "Pick entity first"} />
                        </SelectTrigger>
                        <SelectContent>
                          {filteredDepts.length === 0 ? (
                            <div className="text-xs text-muted-foreground p-2">No teams for this entity</div>
                          ) : filteredDepts.map(d => (
                            <SelectItem key={d.id} value={d.charge_to}>
                              {d.charge_to} — {d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Project Code (optional)</Label>
                      <Select
                        value={line.projectCode || "__none__"}
                        onValueChange={v => updateLine(i, "projectCode", v === "__none__" ? "" : v)}
                      >
                        <SelectTrigger className="h-8 text-sm" data-testid={`split-project-${i}`}>
                          <SelectValue placeholder={line.entityCode ? "Pick project..." : "Pick entity first to filter"} />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          <SelectItem value="__none__">— No project —</SelectItem>
                          {filteredProjects.length === 0 && line.entityCode ? (
                            <div className="text-xs text-muted-foreground p-2">No projects for {line.entityCode}</div>
                          ) : filteredProjects.map(p => (
                            <SelectItem key={p.id} value={p.project_id}>
                              {p.project_id} · {p.project_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Expense Category (optional)</Label>
                      {line.entityCode && noLedgerEntities.has(line.entityCode) ? (
                        <div className="h-8 flex items-center rounded-md border border-border/60 bg-muted/40 px-2.5 text-[11px] text-muted-foreground" data-testid={`split-no-ledger-${i}`}>
                          {line.entityCode} 喺 NetSuite 冇獨立 ledger — 唔使揀 Category（只出 Due From AR）
                        </div>
                      ) : (
                      <Select
                        value={line.expenseCategory || undefined}
                        onValueChange={v => updateLine(i, "expenseCategory", v)}
                      >
                        <SelectTrigger className="h-8 text-sm" data-testid={`split-category-${i}`}>
                          <SelectValue placeholder={line.projectCode ? "Pick [Project] account..." : "Pick GL account..."} />
                        </SelectTrigger>
                        <SelectContent>
                          {(line.projectCode
                            ? expenseCategories.filter(isProjectCat)
                            : expenseCategories.filter(c => !isProjectCat(c))
                          ).map(c => (
                            <SelectItem key={c.category_key} value={c.category_key}>
                              {formatCategoryLabel(c.label_zh || c.label_en, c.ns_account_number)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      )}
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">備註 (optional — 有填會代替 Upload Centre 備註做 journal memo)</Label>
                      <Input
                        type="text"
                        value={line.note}
                        onChange={e => updateLine(i, "note", e.target.value)}
                        placeholder="留空 = 用返 Upload Centre 嘅 invoice 備註"
                        className="h-8 text-sm"
                        data-testid={`split-note-${i}`}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Amount (HKD)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={line.amount}
                        onChange={e => updateLine(i, "amount", parseFloat(e.target.value) || 0)}
                        className="h-8 text-sm tabular-nums"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Percentage (%)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={line.pct}
                        onChange={e => updateLine(i, "pct", parseFloat(e.target.value) || 0)}
                        className="h-8 text-sm tabular-nums"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <Button variant="outline" size="sm" onClick={addLine} className="w-full" data-testid="button-add-split-line">
            <Plus size={14} className="mr-1" /> Add Line
          </Button>

          {/* Balance check */}
          <div className={`flex items-center justify-between p-3 rounded-md text-sm ${
            isBalanced ? 'bg-primary/5 text-primary' : 'bg-destructive/5 text-destructive'
          }`}>
            <span>Split total</span>
            <span className="font-medium tabular-nums">
              {formatCurrency(totalSplit)} / {formatCurrency(totalAmount)}
              {!isBalanced && (
                <span className="ml-2 inline-flex items-center gap-1">
                  <AlertCircle size={14} /> Unbalanced
                </span>
              )}
            </span>
          </div>
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
          {disabledReasons.length > 0 && (
            <div className="text-xs text-destructive space-y-0.5" data-testid="split-disabled-reasons">
              {disabledReasons.map((r, i) => (
                <div key={i} className="flex items-center gap-1"><AlertCircle size={12} /> {r}</div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!isBalanced || !allComplete || saveMutation.isPending}
              data-testid="button-confirm-split"
            >
              {saveMutation.isPending ? <Loader2 className="animate-spin mr-2" size={16} /> : null}
              Save Split
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
