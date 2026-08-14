// ApprovalInboxPage.tsx
// 審批 Inbox — split-pane（左 list, 右 detail）+ keyboard shortcut + bulk approve
// 純為 Team Head / Final Approver 設計，目標：快速過 claim
import { useState, useMemo, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Inbox, Receipt, Car, CheckCircle2, XCircle, FileCheck,
  Keyboard, FileText, ChevronRight, User as UserIcon, ArrowDown,
  AlertCircle, HandCoins,
} from "lucide-react";

type Mode = "team_head" | "final" | "all";

const MODE_LABELS: Record<Mode, { label: string; desc: string }> = {
  team_head: { label: "我要簽（Team Head）", desc: "submitted · 等我簽" },
  final: { label: "Final Approver", desc: "team_head_approved · 等最終批" },
  all: { label: "全部待審", desc: "submitted + team_head_approved" },
};

export default function ApprovalInboxPage() {
  const [, setLocation] = useLocation();
  const { session, isSuperUser, profile } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [mode, setMode] = useState<Mode>(isSuperUser ? "all" : "team_head");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [processing, setProcessing] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [showShortcuts, setShowShortcuts] = useState(false);
  // per-line reject reasons (lineId -> text)
  const [lineRejectReasons, setLineRejectReasons] = useState<Record<string, string>>({});

  // 拉 inbox 清單
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["approval-inbox", mode, session?.user?.id, isSuperUser],
    queryFn: async () => {
      if (!session?.user?.id) return [];
      let q = supabase.from("claim_batches_with_team_head").select("*");
      if (mode === "team_head") {
        q = q.eq("status", "submitted");
        if (!isSuperUser) q = q.eq("assigned_team_head_user_id", session.user.id);
      } else if (mode === "final") {
        q = q.eq("status", "team_head_approved");
      } else {
        q = q.in("status", ["submitted", "team_head_approved"]);
      }
      const { data, error } = await q.order("submit_date", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!session?.user?.id,
  });

  // 揀第一條（如果未揀）
  useEffect(() => {
    if (items.length > 0 && (!selectedId || !items.find((i: any) => i.id === selectedId))) {
      setSelectedId(items[0].id);
    } else if (items.length === 0) {
      setSelectedId(null);
    }
  }, [items, selectedId]);

  const selected = useMemo(() => items.find((i: any) => i.id === selectedId), [items, selectedId]);

  // 拉 selected 嘅 lines + attachments
  const { data: lines = [] } = useQuery({
    queryKey: ["inbox-lines", selectedId],
    queryFn: async () => {
      if (!selectedId) return [];
      const { data } = await supabase.from("claim_lines").select("*").eq("batch_id", selectedId).order("item_no");
      return data || [];
    },
    enabled: !!selectedId,
  });

  const { data: attachments = [] } = useQuery({
    queryKey: ["inbox-attachments", selectedId],
    queryFn: async () => {
      if (!selectedId) return [];
      const { data } = await supabase.from("claim_attachments").select("*").eq("batch_id", selectedId);
      return data || [];
    },
    enabled: !!selectedId,
  });

  const lineAttachments = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of attachments as any[]) {
      if (!a.line_id) continue;
      if (!m.has(a.line_id)) m.set(a.line_id, []);
      m.get(a.line_id)!.push(a);
    }
    return m;
  }, [attachments]);

  const batchAttachments = useMemo(() => (attachments as any[]).filter(a => !a.line_id), [attachments]);

  // Expense categories (lookup)
  const { data: expenseCategories = [] } = useQuery({
    queryKey: ["expense_categories_inbox"],
    queryFn: async () => {
      const { data } = await supabase.from("expense_categories").select("category_key, label_zh, ns_account_number").eq("is_active", true);
      return data || [];
    },
  });

  const categoryMap = useMemo(() => {
    const m = new Map<string, { label_zh: string; ns_account_number: string }>();
    for (const c of expenseCategories as any[]) m.set(c.category_key, { label_zh: c.label_zh, ns_account_number: c.ns_account_number });
    return m;
  }, [expenseCategories]);

  async function openAttachment(path: string) {
    const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  // 跳去下一張
  function goNext() {
    if (!selectedId || items.length === 0) return;
    const idx = items.findIndex((i: any) => i.id === selectedId);
    if (idx === -1 || idx === items.length - 1) {
      setSelectedId(items[0]?.id || null);
      return;
    }
    setSelectedId(items[idx + 1].id);
  }

  // ===== Per-line approve / reject =====
  async function setLineStatus(lineId: string, nextStatus: "approved" | "rejected" | "pending", reason?: string) {
    if (!session?.user?.id) return;
    const now = new Date().toISOString();
    const update: any = { line_status: nextStatus };
    if (nextStatus === "approved") {
      update.line_approved_by_user_id = session.user.id;
      update.line_approved_at = now;
      update.line_reject_reason = null;
      update.line_rejected_by_user_id = null;
      update.line_rejected_at = null;
    } else if (nextStatus === "rejected") {
      const r = (reason ?? lineRejectReasons[lineId] ?? "").trim();
      if (!r) {
        toast({ title: "請填寫這行退回原因", variant: "destructive" });
        return;
      }
      update.line_rejected_by_user_id = session.user.id;
      update.line_rejected_at = now;
      update.line_reject_reason = r;
      update.line_approved_by_user_id = null;
      update.line_approved_at = null;
    } else {
      update.line_approved_by_user_id = null;
      update.line_approved_at = null;
      update.line_rejected_by_user_id = null;
      update.line_rejected_at = null;
      update.line_reject_reason = null;
    }
    const { error } = await supabase.from("claim_lines").update(update).eq("id", lineId);
    if (error) {
      toast({ title: "更新行狀態失敗", description: error.message, variant: "destructive" });
      return;
    }
    if (selectedId) {
      // Fix: await + error-log the audit insert (non-blocking)
      const { error: auditErr } = await supabase.from("claim_audit_log").insert({
        batch_id: selectedId, action: nextStatus === "approved" ? "line_approved" : nextStatus === "rejected" ? "line_rejected" : "line_reset",
        from_status: selected?.status || null, to_status: selected?.status || null,
        actor_user_id: session.user.id,
        comment: nextStatus === "rejected" ? (reason ?? lineRejectReasons[lineId] ?? null) : null,
      });
      if (auditErr) console.error("claim_audit_log insert failed (line status):", auditErr);
    }
    qc.invalidateQueries({ queryKey: ["inbox-lines", selectedId] });
    qc.invalidateQueries({ queryKey: ["approval-inbox"] });
  }

  // Helper: 推進 batch 之前，將仍 pending 的 line 設為 approved；返回狀態統計
  async function resolveLinesForApproval(batchId: string): Promise<{ allRejected: boolean; rejectedCount: number; }> {
    const { data: latest } = await supabase.from("claim_lines").select("id, line_status").eq("batch_id", batchId);
    const all = latest || [];
    const pending = all.filter((l: any) => !l.line_status || l.line_status === "pending");
    if (pending.length > 0 && session?.user?.id) {
      const now = new Date().toISOString();
      // Fix: check error — if line resolution fails, throw so the batch is NOT advanced
      const { error } = await supabase.from("claim_lines").update({
        line_status: "approved",
        line_approved_by_user_id: session.user.id,
        line_approved_at: now,
      }).in("id", pending.map((l: any) => l.id));
      if (error) throw error;
    }
    const rejectedCount = all.filter((l: any) => l.line_status === "rejected").length;
    const approvedCount = all.length - rejectedCount;
    return { allRejected: approvedCount === 0 && all.length > 0, rejectedCount };
  }

  // ===== Approve / Reject =====
  const approveOne = useCallback(async (id: string, currentStatus: string) => {
    if (!session?.user?.id) return;
    const r = await resolveLinesForApproval(id);
    if (r.allRejected) {
      // All lines rejected → batch 變 rejected
      // Fix: optimistic guard (.eq status) + check error + verify a row was affected before audit/success
      const { data: rejData, error: rejErr } = await supabase.from("claim_batches").update({
        status: "rejected",
        rejected_by_user_id: session.user.id,
        rejected_at: new Date().toISOString(),
        reject_reason: comment || "所有 line items 都被退回",
      }).eq("id", id).eq("status", currentStatus).select("id");
      if (rejErr) throw rejErr;
      if (!rejData || rejData.length === 0) throw new Error("狀態已被其他人改動，請重新整理再試");
      // Fix: audit insert — await + error-log (non-blocking)
      const { error: auditErr } = await supabase.from("claim_audit_log").insert({
        batch_id: id, action: "rejected",
        from_status: currentStatus, to_status: "rejected",
        actor_user_id: session.user.id, comment: comment || "所有 line items 都被退回",
      });
      if (auditErr) console.error("claim_audit_log insert failed (batch rejected):", auditErr);
      return;
    }
    const nextStatus = currentStatus === "submitted" ? "team_head_approved" : "approved";
    const updateFields: any = { status: nextStatus };
    if (nextStatus === "team_head_approved") {
      updateFields.team_head_user_id = session.user.id;
      updateFields.team_head_signed_at = new Date().toISOString();
      if (comment) updateFields.team_head_comment = comment;
    } else {
      updateFields.approver_user_id = session.user.id;
      updateFields.approved_at = new Date().toISOString();
      if (comment) updateFields.approver_comment = comment;
    }
    // Fix: optimistic guard (.eq status) + verify a row was affected before audit/success
    const { data: updData, error } = await supabase.from("claim_batches").update(updateFields).eq("id", id).eq("status", currentStatus).select("id");
    if (error) throw error;
    if (!updData || updData.length === 0) throw new Error("狀態已被其他人改動，請重新整理再試");
    // Fix: audit insert — await + error-log (non-blocking)
    const { error: auditErr } = await supabase.from("claim_audit_log").insert({
      batch_id: id, action: nextStatus === "team_head_approved" ? "team_head_approved" : "approved",
      from_status: currentStatus, to_status: nextStatus,
      actor_user_id: session.user.id,
      comment: comment || (r.rejectedCount > 0 ? `${r.rejectedCount} line items rejected` : null),
    });
    if (auditErr) console.error("claim_audit_log insert failed (batch approved):", auditErr);
  }, [session?.user?.id, comment, selected?.status, lineRejectReasons]);  // eslint-disable-line

  async function handleApprove() {
    if (!selected || processing) return;
    // Permission check
    const isAssigned = session?.user?.id === selected.assigned_team_head_user_id;
    const canTH = selected.status === "submitted" && (isAssigned || isSuperUser);
    const canFinal = selected.status === "team_head_approved" && isSuperUser;
    if (!canTH && !canFinal) {
      toast({ title: "你冇權批呢張", variant: "destructive" });
      return;
    }
    setProcessing(true);
    try {
      await approveOne(selected.id, selected.status);
      toast({ title: "已批", description: selected.batch_no });
      setComment("");
      qc.invalidateQueries({ queryKey: ["approval-inbox"] });
      goNext();
    } catch (err: any) {
      toast({ title: "錯誤", description: err.message, variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  }

  async function handleReject() {
    if (!selected || processing) return;
    if (!comment.trim()) {
      toast({ title: "退回必須寫原因", variant: "destructive" });
      return;
    }
    setProcessing(true);
    try {
      // Fix: optimistic guard (.eq status) + verify a row was affected before audit/success
      const { data: rejData, error } = await supabase.from("claim_batches").update({
        status: "rejected",
        rejected_by_user_id: session!.user.id,
        rejected_at: new Date().toISOString(),
        reject_reason: comment,
      }).eq("id", selected.id).eq("status", selected.status).select("id");
      if (error) throw error;
      if (!rejData || rejData.length === 0) throw new Error("狀態已被其他人改動，請重新整理再試");
      // Fix: audit insert — await + error-log (non-blocking)
      const { error: auditErr } = await supabase.from("claim_audit_log").insert({
        batch_id: selected.id, action: "rejected",
        from_status: selected.status, to_status: "rejected",
        actor_user_id: session!.user.id, comment,
      });
      if (auditErr) console.error("claim_audit_log insert failed (batch rejected):", auditErr);
      toast({ title: "已退回", description: selected.batch_no });
      setComment("");
      qc.invalidateQueries({ queryKey: ["approval-inbox"] });
      goNext();
    } catch (err: any) {
      toast({ title: "錯誤", description: err.message, variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  }

  // ===== Bulk approve =====
  async function handleBulkApprove() {
    if (bulkSelected.size === 0) return;
    if (!confirm(`一次過批 ${bulkSelected.size} 張 claim？`)) return;
    setProcessing(true);
    let ok = 0;
    let fail = 0;
    for (const id of Array.from(bulkSelected)) {
      const item = items.find((i: any) => i.id === id);
      if (!item) { fail++; continue; }
      const isAssigned = session?.user?.id === item.assigned_team_head_user_id;
      const canTH = item.status === "submitted" && (isAssigned || isSuperUser);
      const canFinal = item.status === "team_head_approved" && isSuperUser;
      if (!canTH && !canFinal) { fail++; continue; }
      try {
        await approveOne(id, item.status);
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkSelected(new Set());
    toast({ title: `批咗 ${ok} 張`, description: fail > 0 ? `${fail} 張失敗` : "全部成功" });
    qc.invalidateQueries({ queryKey: ["approval-inbox"] });
    setProcessing(false);
  }

  // ===== Keyboard shortcuts =====
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip if user typing in textarea/input
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        if (!selectedId || items.length === 0) return;
        const idx = items.findIndex((i: any) => i.id === selectedId);
        if (idx > 0) setSelectedId(items[idx - 1].id);
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        void handleApprove();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        document.getElementById("inbox-comment")?.focus();
      } else if (e.key === "?" ) {
        setShowShortcuts(s => !s);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleApprove();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, items, comment, processing]); // eslint-disable-line

  // ===== Stats =====
  const totalAmount = useMemo(() => items.reduce((s: number, i: any) => s + Number(i.total_hkd || 0), 0), [items]);

  const canActOnSelected = useMemo(() => {
    if (!selected) return false;
    const isAssigned = session?.user?.id === selected.assigned_team_head_user_id;
    if (selected.status === "submitted") return isAssigned || isSuperUser;
    if (selected.status === "team_head_approved") return isSuperUser;
    return false;
  }, [selected, session?.user?.id, isSuperUser]);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-3">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Inbox size={20} className="text-primary" />
          <h1 className="text-xl font-bold">審批 Inbox</h1>
          <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
            {(["team_head", "final", "all"] as Mode[]).filter(m => m !== "final" || isSuperUser).filter(m => m !== "all" || isSuperUser).map(m => (
              <button key={m} onClick={() => { setMode(m); setBulkSelected(new Set()); }}
                className={`px-2.5 py-1 text-xs rounded ${mode === m ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                {MODE_LABELS[m].label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-muted-foreground">
            {items.length} 張 · 共 HK${totalAmount.toFixed(2)}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowShortcuts(s => !s)} title="快捷鍵 (?)">
            <Keyboard size={14} />
          </Button>
        </div>
      </div>

      {showShortcuts && (
        <Card className="bg-muted/40">
          <CardContent className="p-3 text-xs space-y-1">
            <div className="font-medium mb-1">⌨️ 快捷鍵</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-1">
              <div><kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">↓</kbd> / <kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">j</kbd> 下一張</div>
              <div><kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">↑</kbd> / <kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">k</kbd> 上一張</div>
              <div><kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">A</kbd> 批准</div>
              <div><kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">R</kbd> 跳去寫退回原因</div>
              <div><kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">⌘/Ctrl + Enter</kbd> 批准</div>
              <div><kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px]">?</kbd> 顯示/收埋</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Split pane */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-3 min-h-0">
        {/* LEFT: List */}
        <Card className="flex flex-col min-h-0">
          <CardContent className="p-0 flex-1 flex flex-col min-h-0">
            {/* Bulk action bar */}
            {bulkSelected.size > 0 && (
              <div className="flex items-center justify-between gap-2 p-2 bg-amber-500/10 border-b border-amber-500/30 text-xs">
                <span className="font-medium">已揀 {bulkSelected.size} 張</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setBulkSelected(new Set())} className="h-6 text-[10px]">取消</Button>
                  <Button size="sm" onClick={handleBulkApprove} disabled={processing} className="h-6 text-[10px] bg-emerald-600 hover:bg-emerald-700">
                    <CheckCircle2 size={11} className="mr-1" /> 批准全部
                  </Button>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              {isLoading && (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
                </div>
              )}
              {!isLoading && items.length === 0 && (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-500/50" />
                  Inbox 清晒 — 冇野等緊你簽
                </div>
              )}
              {!isLoading && items.map((item: any) => {
                const isActive = item.id === selectedId;
                const isBulked = bulkSelected.has(item.id);
                const Icon = item.claim_type === "expenses" ? Receipt : item.claim_type === "payment" ? HandCoins : Car;
                return (
                  <div key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`border-b border-border/40 px-3 py-2.5 cursor-pointer transition-colors ${isActive ? "bg-primary/10 border-l-2 border-l-primary" : "hover:bg-muted/40"}`}>
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={isBulked}
                        onCheckedChange={(v) => {
                          const next = new Set(bulkSelected);
                          if (v) next.add(item.id); else next.delete(item.id);
                          setBulkSelected(next);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1"
                      />
                      <Icon size={14} className={`mt-1 ${item.claim_type === "expenses" ? "text-blue-500" : item.claim_type === "payment" ? "text-emerald-600" : "text-orange-500"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono text-[11px] font-medium truncate">{item.batch_no}</span>
                          <span className="text-xs tabular-nums font-medium">HK${Number(item.total_hkd || 0).toFixed(0)}</span>
                        </div>
                        <div className="text-xs truncate">{item.full_name}</div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {item.subsidiary_full_name || item.entity_code} · {item.charge_to_code}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                            item.status === "submitted" ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
                              : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          }`}>
                            {item.status === "submitted" ? "等 TH" : "等 Final"}
                          </span>
                          <span className="text-[9px] text-muted-foreground">{item.submit_date}</span>
                        </div>
                      </div>
                      {isActive && <ChevronRight size={12} className="text-primary mt-1" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* RIGHT: Detail */}
        <Card className="flex flex-col min-h-0">
          <CardContent className="p-0 flex-1 flex flex-col min-h-0">
            {!selected && (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                ← 由左面揀張 claim
              </div>
            )}
            {selected && (
              <>
                {/* Detail header */}
                <div className="p-3 border-b border-border bg-muted/20">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-base font-bold">{selected.batch_no}</span>
                        <button onClick={() => setLocation(`/claims/${selected.id}`)} className="text-[10px] text-muted-foreground hover:text-foreground underline">
                          開完整頁
                        </button>
                      </div>
                      <div className="text-xs mt-0.5">
                        {selected.claim_type === "expenses" ? "日常駛費" : selected.claim_type === "payment" ? "付款申請" : "交通費"} ·{" "}
                        <span className="font-medium">{selected.full_name}</span>
                        {selected.nick_name && <span className="text-muted-foreground"> (@{selected.nick_name})</span>}
                      </div>
                      {selected.claim_type === "payment" && (
                        <div className="text-[10px] text-emerald-700 dark:text-emerald-400">
                          收款人: <span className="font-medium">{selected.payee_name || "—"}</span>
                          {selected.payee_type === "freelancer" ? " (Freelancer)" : selected.payee_type === "supplier" ? " (Supplier)" : ""}
                          {selected.payment_method === "fps"
                            ? ` · FPS: ${selected.payee_fps_id || "—"}`
                            : selected.payee_bank_account ? ` · ${selected.payee_bank || ""} ${selected.payee_bank_account}` : ""}
                          {selected.supplier_invoice_no && ` · INV: ${selected.supplier_invoice_no}`}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {selected.subsidiary_full_name} · {selected.charge_to_code} · 提交 {selected.submit_date}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold tabular-nums">HK${Number(selected.total_hkd || 0).toFixed(2)}</div>
                      <div className="text-[10px] text-muted-foreground">{lines.length} 行 · {attachments.length} 收據</div>
                    </div>
                  </div>
                  {selected.assigned_team_head_name && (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <UserIcon size={10} />
                      Team Head: <span className="font-medium text-foreground">{selected.assigned_team_head_name}</span>
                    </div>
                  )}
                </div>

                {/* Lines + receipts (scrollable) */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {canActOnSelected && (
                    <div className="text-[10px] text-muted-foreground bg-muted/30 rounded p-2 mb-1">
                      提示: 可以逐行按 <kbd className="px-1 bg-background border rounded">✓</kbd> / <kbd className="px-1 bg-background border rounded">✗</kbd>。未設狀態那些預設接受。全部退之後按最下「批」該 batch 會自動變 rejected。
                    </div>
                  )}
                  {lines.map((l: any) => {
                    const lineAtts = lineAttachments.get(l.id) || [];
                    const cat = l.expense_category_code ? categoryMap.get(l.expense_category_code) : null;
                    const lineStatus = l.line_status || "pending";
                    const wrapClass = lineStatus === "rejected"
                      ? "border border-red-500/40 rounded p-2 text-xs bg-red-500/5"
                      : lineStatus === "approved"
                        ? "border border-emerald-500/40 rounded p-2 text-xs bg-emerald-500/5"
                        : "border border-border/60 rounded p-2 text-xs";
                    return (
                      <div key={l.id} className={wrapClass}>
                        <div className="grid grid-cols-12 gap-2 items-start">
                          <div className="col-span-1 font-medium tabular-nums text-muted-foreground">#{l.item_no}</div>
                          <div className="col-span-2 tabular-nums">{l.line_date}</div>
                          <div className="col-span-4">
                            <div className={lineStatus === "rejected" ? "line-through text-muted-foreground" : ""}>
                              {l.description || <span className="text-muted-foreground italic">無說明</span>}
                            </div>
                            {selected.claim_type === "transportation" && (
                              <div className="text-[10px] text-muted-foreground">
                                {l.means_of_transport} · {l.location_from} → {l.destination}
                                {l.taxi_reason && <div className="italic">原因: {l.taxi_reason}</div>}
                              </div>
                            )}
                            {selected.claim_type !== "transportation" && l.client_name && (
                              <div className="text-[10px] text-muted-foreground">Client: {l.client_name}</div>
                            )}
                            {cat && (
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                <span className="font-mono">{cat.ns_account_number}</span> · {cat.label_zh}
                              </div>
                            )}
                            {l.project_code && <div className="text-[10px] font-mono text-muted-foreground">P: {l.project_code}</div>}
                          </div>
                          <div className="col-span-2 text-right">
                            <div className={`tabular-nums font-medium ${lineStatus === "rejected" ? "line-through text-muted-foreground" : ""}`}>
                              HK${Number(l.hkd_amount || 0).toFixed(2)}
                            </div>
                            {selected.claim_type !== "transportation" && l.original_amount && l.currency !== "HKD" && (
                              <div className="text-[10px] text-muted-foreground">{l.currency} {Number(l.original_amount).toFixed(2)} @ {Number(l.fx_rate).toFixed(4)}</div>
                            )}
                          </div>
                          <div className="col-span-3">
                            {lineAtts.length === 0 ? (
                              <div className="text-[10px] text-amber-600 flex items-center gap-1">
                                <AlertCircle size={10} /> 無收據
                              </div>
                            ) : (
                              <div className="flex flex-col gap-0.5">
                                {lineAtts.map((a: any) => (
                                  <button key={a.id} onClick={() => openAttachment(a.storage_path)}
                                    className="flex items-center gap-1 text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/30 px-1.5 py-0.5 rounded">
                                    <FileText size={9} className="flex-shrink-0" />
                                    <span className="truncate max-w-[100px]">{a.file_name}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        {/* Per-line review controls */}
                        {canActOnSelected && (
                          <div className="mt-1.5 pt-1.5 border-t border-border/40 flex items-center gap-1.5 flex-wrap">
                            <Button size="sm"
                              variant={lineStatus === "approved" ? "default" : "outline"}
                              onClick={() => setLineStatus(l.id, "approved")}
                              className={`h-6 px-2 text-[10px] ${lineStatus === "approved" ? "bg-emerald-600 hover:bg-emerald-700" : ""}`}>
                              <CheckCircle2 size={10} className="mr-0.5" /> 接受
                            </Button>
                            <Button size="sm"
                              variant={lineStatus === "rejected" ? "destructive" : "outline"}
                              onClick={() => setLineStatus(l.id, "rejected")}
                              className="h-6 px-2 text-[10px]">
                              <XCircle size={10} className="mr-0.5" /> 退回
                            </Button>
                            {lineStatus !== "pending" && (
                              <Button size="sm" variant="ghost"
                                onClick={() => setLineStatus(l.id, "pending")}
                                className="h-6 px-1.5 text-[10px] text-muted-foreground">重設</Button>
                            )}
                            <Input
                              placeholder="退回這行原因… (退回必填)"
                              value={lineRejectReasons[l.id] ?? l.line_reject_reason ?? ""}
                              onChange={(e) => setLineRejectReasons(s => ({ ...s, [l.id]: e.target.value }))}
                              onBlur={async () => {
                                if (lineStatus === "rejected" && (lineRejectReasons[l.id] || "").trim() && lineRejectReasons[l.id] !== l.line_reject_reason) {
                                  await supabase.from("claim_lines").update({ line_reject_reason: lineRejectReasons[l.id] }).eq("id", l.id);
                                  qc.invalidateQueries({ queryKey: ["inbox-lines", selectedId] });
                                }
                              }}
                              className="h-6 text-[10px] flex-1 min-w-[120px]"
                            />
                          </div>
                        )}
                        {!canActOnSelected && lineStatus !== "pending" && (
                          <div className="mt-1 text-[10px] flex items-center gap-1">
                            <span className={lineStatus === "approved" ? "text-emerald-600 font-medium" : "text-red-600 font-medium"}>
                              {lineStatus === "approved" ? "✓ 接受" : "✗ 退回"}
                            </span>
                            {lineStatus === "rejected" && l.line_reject_reason && (
                              <span className="italic text-red-600">· {l.line_reject_reason}</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {batchAttachments.length > 0 && (
                    <div className="border border-border/60 rounded p-2 bg-muted/20">
                      <div className="text-[10px] font-medium mb-1 text-muted-foreground">Cover Sheet / 整包附件 ({batchAttachments.length})</div>
                      <div className="flex flex-wrap gap-1">
                        {batchAttachments.map((a: any) => (
                          <button key={a.id} onClick={() => openAttachment(a.storage_path)}
                            className="flex items-center gap-1 text-[10px] bg-muted hover:bg-muted/80 px-1.5 py-0.5 rounded">
                            <FileText size={9} />
                            <span className="truncate max-w-[140px]">{a.file_name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Action bar */}
                <div className="p-3 border-t border-border bg-background space-y-2">
                  <Textarea
                    id="inbox-comment"
                    placeholder="加備註（退回必填，批准可空）"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="min-h-[50px] text-sm"
                  />
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-[10px] text-muted-foreground">
                      {canActOnSelected ? (
                        <>提示: <kbd className="px-1 bg-muted rounded text-[9px]">A</kbd> 批准 · <kbd className="px-1 bg-muted rounded text-[9px]">R</kbd> 寫退回原因 · <kbd className="px-1 bg-muted rounded text-[9px]">↓</kbd> 下一張</>
                      ) : (
                        <span className="text-amber-600">⚠ 你冇權處理呢張</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={goNext}>
                        <ArrowDown size={12} className="mr-1" /> 跳過
                      </Button>
                      <Button variant="destructive" size="sm" onClick={handleReject} disabled={processing || !canActOnSelected}>
                        <XCircle size={12} className="mr-1" /> 退回
                      </Button>
                      <Button size="sm" onClick={handleApprove} disabled={processing || !canActOnSelected} className="bg-emerald-600 hover:bg-emerald-700">
                        {selected.status === "submitted" ? <FileCheck size={12} className="mr-1" /> : <CheckCircle2 size={12} className="mr-1" />}
                        {selected.status === "submitted" ? "Team Head 簽核" : "最終批核"}
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
