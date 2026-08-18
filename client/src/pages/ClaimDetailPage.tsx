// ClaimDetailPage.tsx
// 查看 / 批核 / 退回 / 出 Journal CSV
// 支援: per-line approve/reject + 事後補 receipt (submitted/approved 之後依然可以加)
import { useMemo, useState, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { csvText, csvAmount } from "@/lib/csv";
import { toHKDate, todayHK } from "@/lib/hkdate";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Receipt, Car, CheckCircle2, XCircle, FileText,
  Send, FileDown, Clock, FileCheck, User as UserIcon, Download,
  Plus, Trash2, AlertCircle, HandCoins,
} from "lucide-react";

// Status states that allow attaching extra receipts post-submit
const POST_SUBMIT_ATTACH_STATUSES = new Set(["submitted", "team_head_approved", "approved"]);
// Status states that allow per-line approve/reject toggling
const PER_LINE_REVIEW_STATUSES = new Set(["submitted", "team_head_approved"]);

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: "草稿", color: "bg-muted text-muted-foreground" },
  submitted: { label: "已提交 · 等 Team Head", color: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  team_head_approved: { label: "Team Head 已簽 · 等 Final Approver", color: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  approved: { label: "已批核", color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  exported: { label: "已出 Journal", color: "bg-purple-500/15 text-purple-700 dark:text-purple-400" },
  rejected: { label: "已退回", color: "bg-red-500/15 text-red-700 dark:text-red-400" },
};

export default function ClaimDetailPage() {
  const [, params] = useRoute<{ id: string }>("/claims/:id");
  const [, setLocation] = useLocation();
  const { profile, session, isSuperUser } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const claimId = params?.id;
  const [comment, setComment] = useState("");
  const [processing, setProcessing] = useState(false);
  // per-line reject reason being typed (lineId -> text)
  const [lineRejectReasons, setLineRejectReasons] = useState<Record<string, string>>({});
  const [uploadingLineId, setUploadingLineId] = useState<string | null>(null);
  const lineFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploadLineId, setPendingUploadLineId] = useState<string | null>(null);

  // Fetch batch
  const { data: batch, isLoading: loadingBatch } = useQuery({
    queryKey: ["claim-batch", claimId],
    queryFn: async () => {
      if (!claimId) return null;
      const { data, error } = await supabase
        .from("claim_batches_with_team_head")
        .select("*")
        .eq("id", claimId)
        .single();
      if (error) throw error;
      return data as any;
    },
    enabled: !!claimId,
  });

  // Fetch lines
  const { data: lines = [] } = useQuery({
    queryKey: ["claim-lines", claimId],
    queryFn: async () => {
      if (!claimId) return [];
      const { data, error } = await supabase
        .from("claim_lines")
        .select("*")
        .eq("batch_id", claimId)
        .order("item_no");
      if (error) throw error;
      return data || [];
    },
    enabled: !!claimId,
  });

  // Fetch attachments (同時 batch 級 + line 級)
  const { data: attachments = [] } = useQuery({
    queryKey: ["claim-attachments", claimId],
    queryFn: async () => {
      if (!claimId) return [];
      const { data, error } = await supabase
        .from("claim_attachments")
        .select("*")
        .eq("batch_id", claimId)
        .order("uploaded_at");
      if (error) return [];
      return data || [];
    },
    enabled: !!claimId,
  });

  // Group attachments by line_id
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

  // Expense categories — settings 入面嘅 mapping (同 credit card recon 一樣)
  const { data: expenseCategories = [] } = useQuery({
    queryKey: ["expense_categories_claim_detail"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("category_key, label_zh, label_en, ns_account_number")
        .eq("is_active", true);
      if (error) return [];
      return data || [];
    },
  });

  const categoryMap = useMemo(() => {
    const m = new Map<string, { label_zh: string; label_en: string; ns_account_number: string }>();
    for (const c of expenseCategories as any[]) {
      m.set(c.category_key, { label_zh: c.label_zh, label_en: c.label_en, ns_account_number: c.ns_account_number });
    }
    return m;
  }, [expenseCategories]);

  // Fallback account if category not mapped (会在 CSV 中顯示)
  const FALLBACK_ACCOUNT = "81000090"; // 其他雜項 sundry
  const STAFF_PAYABLE_ACCOUNT = "2XXX-Staff-Reimbursement-Payable"; // user 之後配

  // Fetch audit log
  const { data: auditLog = [] } = useQuery({
    queryKey: ["claim-audit", claimId],
    queryFn: async () => {
      if (!claimId) return [];
      const { data, error } = await supabase
        .from("claim_audit_log")
        .select("*, user_profiles!claim_audit_log_actor_user_id_fkey(email, full_name)")
        .eq("batch_id", claimId)
        .order("created_at", { ascending: false });
      if (error) return [];
      return data || [];
    },
    enabled: !!claimId,
  });

  const claimType = batch?.claim_type || "expenses";
  const status = batch?.status || "draft";

  // Permission checks
  const isClaimant = session?.user?.id === batch?.claimant_user_id;
  const isAssignedTeamHead = session?.user?.id === batch?.assigned_team_head_user_id;

  const canTeamHeadApprove = (status === "submitted") && (isAssignedTeamHead || isSuperUser);
  const canFinalApprove = (status === "team_head_approved") && isSuperUser;
  const canReject = (["submitted", "team_head_approved"].includes(status)) && (isAssignedTeamHead || isSuperUser);
  const canExport = (status === "approved") && isSuperUser;
  const canReviewPerLine = PER_LINE_REVIEW_STATUSES.has(status) && (isAssignedTeamHead || isSuperUser);
  const canAttachPostSubmit = POST_SUBMIT_ATTACH_STATUSES.has(status) && (isClaimant || isSuperUser);

  // Fix: audit-log inserts were fire-and-forget. Route them through this helper
  // so a failed insert is logged + surfaced to the user, without ever blocking
  // (or reverting) the main action that already succeeded.
  async function logAudit(entry: Record<string, any>) {
    const { error } = await supabase.from("claim_audit_log").insert(entry);
    if (error) {
      console.error("claim_audit_log insert failed", error, entry);
      toast({ title: "審計紀錄寫入失敗（操作已完成）", description: error.message, variant: "destructive" });
    }
  }

  // ===== Per-line approve / reject =====
  async function setLineStatus(lineId: string, nextStatus: "approved" | "rejected" | "pending") {
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
      const reason = (lineRejectReasons[lineId] || "").trim();
      if (!reason) {
        toast({ title: "請填寫該行退回原因", variant: "destructive" });
        return;
      }
      update.line_rejected_by_user_id = session.user.id;
      update.line_rejected_at = now;
      update.line_reject_reason = reason;
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
    await logAudit({
      batch_id: claimId, action: nextStatus === "approved" ? "line_approved" : nextStatus === "rejected" ? "line_rejected" : "line_reset",
      from_status: status, to_status: status,
      actor_user_id: session.user.id,
      comment: nextStatus === "rejected" ? (lineRejectReasons[lineId] || null) : null,
    });
    qc.invalidateQueries({ queryKey: ["claim-lines", claimId] });
    qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
  }

  // ===== Post-submit receipt attach =====
  function triggerLineUpload(lineId: string) {
    setPendingUploadLineId(lineId);
    setTimeout(() => lineFileInputRef.current?.click(), 0);
  }

  async function handleLineFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const lineId = pendingUploadLineId;
    const files = e.target.files;
    if (!files || files.length === 0 || !lineId || !claimId || !session?.user?.id || !batch) {
      setPendingUploadLineId(null);
      return;
    }
    setUploadingLineId(lineId);
    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop() || "";
        const path = `claims/${claimId}/${lineId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file);
        if (upErr) {
          toast({ title: "上傳失敗", description: upErr.message, variant: "destructive" });
          continue;
        }
        const { error: insErr } = await supabase.from("claim_attachments").insert({
          batch_id: claimId,
          line_id: lineId,
          storage_path: path,
          file_name: file.name,
          mime_type: file.type || null,
          size_bytes: file.size,
          uploaded_by_user_id: session.user.id,
        });
        if (insErr) {
          toast({ title: "記錄附件失敗", description: insErr.message, variant: "destructive" });
          continue;
        }
      }
      // Mark line has_receipt = true if was false
      await supabase.from("claim_lines").update({ has_receipt: true }).eq("id", lineId);
      await logAudit({
        batch_id: claimId, action: "receipt_added_post_submit",
        from_status: status, to_status: status,
        actor_user_id: session.user.id,
        comment: `Line attached ${files.length} file(s) after submit`,
      });
      toast({ title: "已加收據", description: `加咗 ${files.length} 個檔案` });
      qc.invalidateQueries({ queryKey: ["claim-attachments", claimId] });
      qc.invalidateQueries({ queryKey: ["claim-lines", claimId] });
    } finally {
      setUploadingLineId(null);
      setPendingUploadLineId(null);
      if (lineFileInputRef.current) lineFileInputRef.current.value = "";
    }
  }

  async function deleteAttachment(attId: string, storagePath: string) {
    if (!confirm("刪除呢個收據？")) return;
    // Fix: delete the DB row first (and check it). If the DB delete fails we keep
    // the storage object rather than orphaning the file; only remove storage after
    // the row is gone.
    const { error: delErr } = await supabase.from("claim_attachments").delete().eq("id", attId);
    if (delErr) {
      toast({ title: "刪除失敗", description: delErr.message, variant: "destructive" });
      return;
    }
    const { error: rmErr } = await supabase.storage.from("documents").remove([storagePath]);
    if (rmErr) {
      console.error("storage remove failed", rmErr);
      toast({ title: "附件記錄已刪除，但檔案可能未清除", description: rmErr.message, variant: "destructive" });
    }
    qc.invalidateQueries({ queryKey: ["claim-attachments", claimId] });
    toast({ title: "已刪除" });
  }

  async function openAttachment(path: string) {
    const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  async function submitClaim() {
    if (!claimId || !session?.user?.id) return;
    setProcessing(true);
    try {
      // Optimistic concurrency: only transition if the batch is still in the
      // status we rendered from; verify a row was actually changed before
      // recording the audit row / showing success.
      const { data: updated, error } = await supabase.from("claim_batches").update({
        status: "submitted",
      }).eq("id", claimId).eq("status", status).select();
      if (error) throw error;
      if (!updated || updated.length === 0) {
        toast({ title: "claim 已被其他人改動，請重新整理再試", variant: "destructive" });
        qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
        return;
      }
      await logAudit({
        batch_id: claimId, action: "submitted",
        from_status: status, to_status: "submitted",
        actor_user_id: session.user.id,
      });
      toast({ title: "已提交", description: "Team Head 會收到通知" });
      qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
    } catch (err: any) {
      toast({ title: "錯誤", description: err.message, variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  }

  // Helper: 出咩 batch 推進之前需要以 line_status 判斷 batch 變 approved 變 rejected
  // 如果 有 line 沒 set status (仍 pending)，被認為 approved
  // 如果 全部 lines 都 rejected → batch 變 rejected
  // 否則 batch 變 approved (有 rejected lines 並不阻止推進，trigger 會 set has_rejected_lines=true)
  async function resolveLineStatusesForApproval(): Promise<{ allRejected: boolean; approvedCount: number; rejectedCount: number; }> {
    // 抓最新 lines
    const { data: latestLines } = await supabase.from("claim_lines").select("id, line_status").eq("batch_id", claimId);
    const all = latestLines || [];
    // 任何仍 pending 那些 → 設 approved (預設接受)
    const pending = all.filter((l: any) => !l.line_status || l.line_status === "pending");
    if (pending.length > 0 && session?.user?.id) {
      const now = new Date().toISOString();
      // Fix: check the error. If we can't finalize the pending lines, throw so the
      // caller aborts and does NOT advance the batch status (no silent no-op).
      const { error: pendErr } = await supabase.from("claim_lines").update({
        line_status: "approved",
        line_approved_by_user_id: session.user.id,
        line_approved_at: now,
      }).in("id", pending.map((l: any) => l.id));
      if (pendErr) throw new Error("更新 line 狀態失敗，未推進 batch：" + pendErr.message);
    }
    // 重新計算
    const approvedCount = all.length - all.filter((l: any) => l.line_status === "rejected").length;
    const rejectedCount = all.filter((l: any) => l.line_status === "rejected").length;
    return { allRejected: approvedCount === 0 && all.length > 0, approvedCount, rejectedCount };
  }

  async function teamHeadApprove() {
    if (!claimId || !session?.user?.id) return;
    setProcessing(true);
    try {
      const r = await resolveLineStatusesForApproval();
      if (r.allRejected) {
        // 全部 line 被 rejected → batch 直接變 rejected
        // Optimistic concurrency: only transition from "submitted"; abort if no row changed.
        const { data: updated, error } = await supabase.from("claim_batches").update({
          status: "rejected",
          rejected_by_user_id: session.user.id,
          rejected_at: new Date().toISOString(),
          reject_reason: comment || "所有 line items 都被退回",
        }).eq("id", claimId).eq("status", "submitted").select();
        if (error) throw error;
        if (!updated || updated.length === 0) {
          toast({ title: "claim 已被其他人改動，請重新整理再試", variant: "destructive" });
          qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
          return;
        }
        await logAudit({
          batch_id: claimId, action: "rejected",
          from_status: status, to_status: "rejected",
          actor_user_id: session.user.id, comment: comment || "所有 line items 都被退回",
        });
        toast({ title: "全部 line 被退回 → batch 變 rejected" });
      } else {
        const { data: updated, error } = await supabase.from("claim_batches").update({
          status: "team_head_approved",
          team_head_user_id: session.user.id,
          team_head_signed_at: new Date().toISOString(),
          team_head_comment: comment || null,
        }).eq("id", claimId).eq("status", "submitted").select();
        if (error) throw error;
        if (!updated || updated.length === 0) {
          toast({ title: "claim 已被其他人改動，請重新整理再試", variant: "destructive" });
          qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
          return;
        }
        await logAudit({
          batch_id: claimId, action: "team_head_approved",
          from_status: status, to_status: "team_head_approved",
          actor_user_id: session.user.id,
          comment: comment || (r.rejectedCount > 0 ? `${r.rejectedCount} line items rejected` : null),
        });
        toast({ title: r.rejectedCount > 0 ? `已簽核 (${r.rejectedCount} 行退回)` : "已簽核", description: "Final Approver 會收到通知" });
      }
      setComment("");
      qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
      qc.invalidateQueries({ queryKey: ["claim-lines", claimId] });
    } catch (err: any) {
      toast({ title: "錯誤", description: err.message, variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  }

  async function finalApprove() {
    if (!claimId || !session?.user?.id) return;
    setProcessing(true);
    try {
      const r = await resolveLineStatusesForApproval();
      if (r.allRejected) {
        // Optimistic concurrency: only transition from "team_head_approved".
        const { data: updated, error } = await supabase.from("claim_batches").update({
          status: "rejected",
          rejected_by_user_id: session.user.id,
          rejected_at: new Date().toISOString(),
          reject_reason: comment || "所有 line items 都被退回",
        }).eq("id", claimId).eq("status", "team_head_approved").select();
        if (error) throw error;
        if (!updated || updated.length === 0) {
          toast({ title: "claim 已被其他人改動，請重新整理再試", variant: "destructive" });
          qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
          return;
        }
        await logAudit({
          batch_id: claimId, action: "rejected",
          from_status: status, to_status: "rejected",
          actor_user_id: session.user.id, comment: comment || "所有 line items 都被退回",
        });
        toast({ title: "全部 line 被退回 → batch 變 rejected" });
      } else {
        const { data: updated, error } = await supabase.from("claim_batches").update({
          status: "approved",
          approver_user_id: session.user.id,
          approved_at: new Date().toISOString(),
          approver_comment: comment || null,
        }).eq("id", claimId).eq("status", "team_head_approved").select();
        if (error) throw error;
        if (!updated || updated.length === 0) {
          toast({ title: "claim 已被其他人改動，請重新整理再試", variant: "destructive" });
          qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
          return;
        }
        await logAudit({
          batch_id: claimId, action: "approved",
          from_status: status, to_status: "approved",
          actor_user_id: session.user.id,
          comment: comment || (r.rejectedCount > 0 ? `${r.rejectedCount} line items rejected` : null),
        });
        toast({ title: r.rejectedCount > 0 ? `已批核 (${r.rejectedCount} 行退回不出入賬)` : "已批核", description: "可以匯出 Journal CSV" });
      }
      setComment("");
      qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
      qc.invalidateQueries({ queryKey: ["claim-lines", claimId] });
    } catch (err: any) {
      toast({ title: "錯誤", description: err.message, variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  }

  async function reject() {
    if (!claimId || !session?.user?.id) return;
    if (!comment.trim()) {
      toast({ title: "請填寫退回原因", variant: "destructive" });
      return;
    }
    setProcessing(true);
    try {
      // Optimistic concurrency: only reject from the status we rendered from.
      const { data: updated, error } = await supabase.from("claim_batches").update({
        status: "rejected",
        rejected_by_user_id: session.user.id,
        rejected_at: new Date().toISOString(),
        reject_reason: comment,
      }).eq("id", claimId).eq("status", status).select();
      if (error) throw error;
      if (!updated || updated.length === 0) {
        toast({ title: "claim 已被其他人改動，請重新整理再試", variant: "destructive" });
        qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
        return;
      }
      await logAudit({
        batch_id: claimId, action: "rejected",
        from_status: status, to_status: "rejected",
        actor_user_id: session.user.id, comment: comment,
      });
      toast({ title: "已退回" });
      setComment("");
      qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
    } catch (err: any) {
      toast({ title: "錯誤", description: err.message, variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  }

  function exportJournalCsv() {
    if (!batch) return;
    // Generate NetSuite Journal CSV
    // Format: Date, Subsidiary, Account, Department, Project, Memo, Debit, Credit
    const rows: any[] = [];
    // Journal date in HK-local time (approved_at is a timestamptz) so a late-night
    // approval doesn't post to the wrong day.
    const journalDate = toHKDate(batch.approved_at) || batch.submit_date || todayHK();
    const subsidiary = batch.subsidiary_full_name || batch.entity_code || "";
    const department = batch.charge_to_code;
    const claimantName = batch.nick_name || batch.full_name || "Staff";

    // Debit lines = each claim line (由 expense_categories 寫 account)
    // 仂出 line_status='approved' (或未設以預設當 approved) 那些
    let total = 0;
    for (const l of lines as any[]) {
      if (l.line_status === "rejected") continue;
      const cat = l.expense_category_code ? categoryMap.get(l.expense_category_code) : null;
      const expenseAccount = cat?.ns_account_number || FALLBACK_ACCOUNT;
      const memo = claimType === "transportation"
        ? `${batch.batch_no} ${l.means_of_transport || ""} ${l.location_from || ""} → ${l.destination || ""}`.trim()
        : `${batch.batch_no} ${l.description || ""} ${l.client_name ? `(${l.client_name})` : ""}`.trim();
      const debit = Number(l.hkd_amount || 0);
      total += debit;
      rows.push({
        Date: journalDate,
        Subsidiary: subsidiary,
        Account: expenseAccount,
        Department: department,
        Project: l.project_code || "",
        Memo: memo,
        Debit: debit,   // numeric — encoded via csvAmount
        Credit: null,
      });
    }
    // Credit line = Staff Advance / Payable to Employee
    rows.push({
      Date: journalDate,
      Subsidiary: subsidiary,
      Account: STAFF_PAYABLE_ACCOUNT,
      Department: department,
      Project: "",
      Memo: `${batch.batch_no} payable to ${claimType === "payment" ? (batch.payee_name || claimantName) : claimantName}`,
      Debit: null,
      Credit: total,
    });

    // CSV — text columns via csvText (formula-injection safe + quoted/escaped),
    // Debit/Credit via csvAmount (plain 2-dp numeric cells).
    const header = ["Date", "Subsidiary", "Account", "Department", "Project", "Memo", "Debit", "Credit"];
    const csv = [
      header.join(","),
      ...rows.map(r => [
        csvText(r.Date),
        csvText(r.Subsidiary),
        csvText(r.Account),
        csvText(r.Department),
        csvText(r.Project),
        csvText(r.Memo),
        csvAmount(r.Debit),
        csvAmount(r.Credit),
      ].join(",")),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${batch.batch_no}_journal.csv`;
    link.click();
    URL.revokeObjectURL(url);

    // Mark exported
    void markExported();
  }

  async function markExported() {
    if (!claimId || !session?.user?.id || !batch) return;
    if (batch.status === "exported") return;
    // Optimistic concurrency: only mark exported from "approved"; if no row changed
    // (already exported / rejected elsewhere) abort without writing an audit row.
    const { data: updated, error } = await supabase.from("claim_batches").update({
      status: "exported",
      exported_at: new Date().toISOString(),
      exported_by_user_id: session.user.id,
    }).eq("id", claimId).eq("status", "approved").select();
    if (error) {
      toast({ title: "標記匯出失敗", description: error.message, variant: "destructive" });
      return;
    }
    if (!updated || updated.length === 0) {
      toast({ title: "claim 已被其他人改動，請重新整理再試", variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
      return;
    }
    await logAudit({
      batch_id: claimId, action: "exported",
      from_status: batch.status, to_status: "exported",
      actor_user_id: session.user.id,
    });
    qc.invalidateQueries({ queryKey: ["claim-batch", claimId] });
  }

  if (loadingBatch) {
    return <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>;
  }
  if (!batch) {
    return <div className="p-12 text-center text-muted-foreground">找不到呢張 claim</div>;
  }

  const Icon = claimType === "expenses" ? Receipt : claimType === "payment" ? HandCoins : Car;
  const statusInfo = STATUS_LABELS[status] || STATUS_LABELS.draft;
  const totalHkd = lines.reduce((s, l) => s + Number(l.hkd_amount || 0), 0);
  const approvedTotalHkd = lines.reduce((s, l: any) => l.line_status === "rejected" ? s : s + Number(l.hkd_amount || 0), 0);
  const rejectedLineCount = lines.filter((l: any) => l.line_status === "rejected").length;

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation(claimType === "payment" ? "/payments" : "/claims")} data-testid="button-back">
            <ArrowLeft size={16} className="mr-1" /> 返回
          </Button>
          <div className="flex items-center gap-2">
            <Icon size={20} className="text-primary" />
            <div>
              <div className="text-xl font-bold font-mono">{batch.batch_no}</div>
              <div className="text-xs text-muted-foreground">
                {claimType === "expenses" ? "日常駛費" : claimType === "payment" ? "付款申請" : "交通費用"} · {batch.period_month}
              </div>
            </div>
          </div>
        </div>
        <div className={`px-3 py-1.5 rounded-md text-sm font-medium ${statusInfo.color}`}>
          {statusInfo.label}
        </div>
      </div>

      {/* Header info */}
      <Card><CardContent className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">申請人</div>
            <div className="font-medium">{batch.full_name}</div>
            {batch.nick_name && <div className="text-xs text-muted-foreground">@{batch.nick_name}</div>}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Department</div>
            <div className="font-medium">{batch.department || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Charge To</div>
            <div className="font-mono text-sm">{batch.charge_to_code}</div>
            <div className="text-xs text-muted-foreground">{batch.subsidiary_full_name}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">總金額 (HKD)</div>
            <div className="text-xl font-bold tabular-nums">${totalHkd.toFixed(2)}</div>
            <div className="text-xs text-muted-foreground">{lines.length} 行</div>
          </div>
        </div>

        {/* 付款申請 — 收款人 + 付款資料 */}
        {claimType === "payment" && (
          <div className="mt-3 pt-3 border-t border-border/40 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">收款人</div>
              <div className="font-medium">{batch.payee_name || "—"}</div>
              <div className="text-xs text-muted-foreground">
                {batch.payee_type === "freelancer" ? "Freelancer 自由工作者" : batch.payee_type === "supplier" ? "Supplier 供應商" : ""}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">付款方式</div>
              <div className="font-medium">
                {({ bank_transfer: "銀行轉賬", fps: "FPS 轉數快", cheque: "支票", autopay: "自動轉賬", other: "其他" } as Record<string, string>)[batch.payment_method] || "—"}
              </div>
              {batch.payment_due_date && <div className="text-xs text-muted-foreground">到期: {batch.payment_due_date}</div>}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">收款戶口</div>
              {batch.payment_method === "fps" ? (
                <div className="font-mono text-xs">FPS: {batch.payee_fps_id || "—"}</div>
              ) : (
                <>
                  <div className="text-xs">{batch.payee_bank || "—"}</div>
                  <div className="font-mono text-xs">{batch.payee_bank_account || ""}</div>
                </>
              )}
              {batch.payee_account_name && <div className="text-xs text-muted-foreground">{batch.payee_account_name}</div>}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Supplier Invoice #</div>
              <div className="font-mono text-xs">{batch.supplier_invoice_no || "—"}</div>
            </div>
            {/* IR56M 個人資料 (freelancer 新收款人 / 兩年冇交易先有) */}
            {(batch.payee_hkid || batch.payee_phone || batch.payee_address || batch.payee_gender) && (
              <div className="col-span-2 md:col-span-4 rounded bg-amber-500/10 px-3 py-2 text-xs">
                <span className="font-medium text-amber-700 dark:text-amber-400 mr-2">IR56M 個人資料:</span>
                HKID <span className="font-mono">{batch.payee_hkid || "—"}</span>
                {" · "}性別 {batch.payee_gender === "M" ? "男" : batch.payee_gender === "F" ? "女" : "—"}
                {" · "}電話 <span className="font-mono">{batch.payee_phone || "—"}</span>
                {" · "}住址 {batch.payee_address || "—"}
              </div>
            )}
          </div>
        )}

        {batch.assigned_team_head_name && (
          <div className="mt-3 pt-3 border-t border-border/40 flex items-center gap-3 text-xs">
            <UserIcon size={14} className="text-muted-foreground" />
            <span>Team Head: <span className="font-medium">{batch.assigned_team_head_name}</span></span>
            <span className="text-muted-foreground">({batch.assigned_team_head_email})</span>
          </div>
        )}
        {batch.reject_reason && (
          <div className="mt-3 p-3 rounded bg-red-500/10 text-sm text-red-700 dark:text-red-400">
            <div className="font-medium text-xs mb-1">退回原因:</div>
            {batch.reject_reason}
          </div>
        )}
      </CardContent></Card>

      {/* Lines */}
      <Card><CardContent className="p-0">
        {/* Hidden file input for post-submit receipt upload */}
        <input
          ref={lineFileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          onChange={handleLineFileSelected}
        />
        {canAttachPostSubmit && (
          <div className="px-3 py-2 bg-blue-500/10 border-b border-blue-500/20 text-xs text-blue-700 dark:text-blue-400 flex items-center gap-2">
            <AlertCircle size={12} />
            <span>現狀態: <b>{statusInfo.label}</b>。你依然可以「補收據」加 attachment，但不能改金額 / 修改 line。</span>
          </div>
        )}
        {canReviewPerLine && (
          <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2">
            <AlertCircle size={12} />
            <span>記住：可以逐行 <b>OK / 退</b>。未設狀態的行預設接受。如果要退回整張，可以下面「退回」；或者逐行都退之後按「最終批核 / Team Head 簽核」會自動變 rejected。</span>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 border-b border-border">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">日期</th>
                <th className="px-3 py-2 text-left">Project</th>
                {claimType !== "transportation" && <th className="px-3 py-2 text-left">Client</th>}
                {claimType === "transportation" && <>
                  <th className="px-3 py-2 text-left">交通工具</th>
                  <th className="px-3 py-2 text-left">類別 / Account</th>
                  <th className="px-3 py-2 text-left">由 → 去</th>
                </>}
                <th className="px-3 py-2 text-left">說明</th>
                {claimType !== "transportation" && <>
                  <th className="px-3 py-2 text-left">類別 / Account</th>
                  <th className="px-3 py-2 text-right">幣別 / 原幣</th>
                  <th className="px-3 py-2 text-right">FX</th>
                </>}
                <th className="px-3 py-2 text-right">HKD</th>
                <th className="px-3 py-2 text-center w-[160px]">收據</th>
                {canReviewPerLine && <th className="px-3 py-2 text-center w-[200px]">審核</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l: any) => {
                const lineStatus = l.line_status || "pending";
                const lineRowClass = lineStatus === "rejected"
                  ? "border-b border-border/40 bg-red-500/5"
                  : lineStatus === "approved"
                    ? "border-b border-border/40 bg-emerald-500/5"
                    : "border-b border-border/40";
                return (
                <tr key={l.id} className={lineRowClass}>
                  <td className="px-3 py-2 tabular-nums">{l.item_no}</td>
                  <td className="px-3 py-2 tabular-nums">{l.line_date}</td>
                  <td className="px-3 py-2 font-mono">{l.project_code || "—"}</td>
                  {claimType !== "transportation" && <td className="px-3 py-2">{l.client_name || "—"}</td>}
                  {claimType === "transportation" && <>
                    <td className="px-3 py-2">
                      {l.means_of_transport}
                      {l.taxi_reason && <div className="text-[10px] text-muted-foreground">{l.taxi_reason}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {(() => {
                        const cat = l.expense_category_code ? categoryMap.get(l.expense_category_code) : null;
                        return cat ? <><div>{cat.label_zh}</div><div className="font-mono text-[10px] text-muted-foreground">{cat.ns_account_number}</div></> : "—";
                      })()}
                    </td>
                    <td className="px-3 py-2 text-xs">{l.location_from} → {l.destination}</td>
                  </>}
                  <td className="px-3 py-2">{l.description}</td>
                  {claimType !== "transportation" && <>
                    <td className="px-3 py-2 text-xs">
                      {(() => {
                        const cat = l.expense_category_code ? categoryMap.get(l.expense_category_code) : null;
                        return cat ? <><div>{cat.label_zh}</div><div className="font-mono text-[10px] text-muted-foreground">{cat.ns_account_number}</div></> : "—";
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.currency} {Number(l.original_amount || 0).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(l.fx_rate || 0).toFixed(4)}</td>
                  </>}
                  <td className="px-3 py-2 text-right tabular-nums font-medium">
                    <span className={lineStatus === "rejected" ? "line-through text-muted-foreground" : ""}>${Number(l.hkd_amount || 0).toFixed(2)}</span>
                    {lineStatus !== "pending" && (
                      <div className={`text-[9px] mt-0.5 font-medium ${lineStatus === "approved" ? "text-emerald-600" : "text-red-600"}`}>
                        {lineStatus === "approved" ? "✓ 接受" : "✗ 退回"}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {(() => {
                      const lineAtts = lineAttachments.get(l.id) || [];
                      const isUploading = uploadingLineId === l.id;
                      return (
                        <div className="flex flex-col gap-0.5">
                          {lineAtts.length === 0 && !canAttachPostSubmit && (
                            <div className="text-center text-muted-foreground text-[10px]">{l.has_receipt ? "✓" : "—"}</div>
                          )}
                          {lineAtts.map((a: any) => (
                            <div key={a.id} className="flex items-center gap-0.5 max-w-[140px]">
                              <button onClick={() => openAttachment(a.storage_path)}
                                className="flex-1 flex items-center gap-1 text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 px-1.5 py-0.5 rounded min-w-0"
                                title={a.file_name}>
                                <FileText size={10} className="flex-shrink-0" />
                                <span className="truncate">{a.file_name}</span>
                              </button>
                              {(isClaimant || isSuperUser) && (status === "draft" || status === "rejected") && (
                                <button onClick={() => deleteAttachment(a.id, a.storage_path)}
                                  className="text-red-500/60 hover:text-red-600 p-0.5" title="刪除">
                                  <Trash2 size={9} />
                                </button>
                              )}
                            </div>
                          ))}
                          {canAttachPostSubmit && (
                            <button onClick={() => triggerLineUpload(l.id)} disabled={isUploading}
                              className="flex items-center justify-center gap-1 text-[9px] bg-blue-500/10 text-blue-700 dark:text-blue-400 hover:bg-blue-500/20 px-1.5 py-0.5 rounded border border-dashed border-blue-500/30">
                              <Plus size={9} /> {isUploading ? "上傳中..." : "補收據"}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  {canReviewPerLine && (
                    <td className="px-3 py-2" colSpan={1}>
                      <div className="flex flex-col gap-1 min-w-[180px]">
                        <div className="flex gap-1">
                          <Button size="sm" variant={lineStatus === "approved" ? "default" : "outline"}
                            onClick={() => setLineStatus(l.id, "approved")}
                            className={`h-6 px-1.5 text-[10px] ${lineStatus === "approved" ? "bg-emerald-600 hover:bg-emerald-700" : ""}`}
                            title="接受這行">
                            <CheckCircle2 size={10} className="mr-0.5" /> OK
                          </Button>
                          <Button size="sm" variant={lineStatus === "rejected" ? "destructive" : "outline"}
                            onClick={() => setLineStatus(l.id, "rejected")}
                            className="h-6 px-1.5 text-[10px]"
                            title="退回這行">
                            <XCircle size={10} className="mr-0.5" /> 退
                          </Button>
                          {lineStatus !== "pending" && (
                            <Button size="sm" variant="ghost"
                              onClick={() => setLineStatus(l.id, "pending")}
                              className="h-6 px-1 text-[10px] text-muted-foreground"
                              title="重設">
                              ⥁
                            </Button>
                          )}
                        </div>
                        {(lineStatus === "rejected" || (lineRejectReasons[l.id] && lineRejectReasons[l.id].length > 0)) && (
                          <Input
                            placeholder="退回原因…"
                            value={lineRejectReasons[l.id] ?? l.line_reject_reason ?? ""}
                            onChange={(e) => setLineRejectReasons(s => ({ ...s, [l.id]: e.target.value }))}
                            onBlur={async () => {
                              if (lineStatus === "rejected" && (lineRejectReasons[l.id] || "").trim() && lineRejectReasons[l.id] !== l.line_reject_reason) {
                                await supabase.from("claim_lines").update({ line_reject_reason: lineRejectReasons[l.id] }).eq("id", l.id);
                                qc.invalidateQueries({ queryKey: ["claim-lines", claimId] });
                              }
                            }}
                            className="h-6 text-[10px]"
                          />
                        )}
                        {lineStatus === "rejected" && l.line_reject_reason && (
                          <div className="text-[9px] text-red-600 italic">{l.line_reject_reason}</div>
                        )}
                      </div>
                    </td>
                  )}
                  {!canReviewPerLine && lineStatus === "rejected" && l.line_reject_reason && (
                    <td className="px-3 py-2">
                      <div className="text-[10px] text-red-600 italic max-w-[180px]">{l.line_reject_reason}</div>
                    </td>
                  )}
                </tr>
              );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-medium bg-muted/20">
                <td colSpan={claimType !== "transportation" ? 9 : 7} className="px-3 py-2 text-right">TOTAL</td>
                <td className="px-3 py-2 text-right tabular-nums">${totalHkd.toFixed(2)}</td>
                <td></td>
                {canReviewPerLine && <td></td>}
              </tr>
              {approvedTotalHkd !== totalHkd && (
                <tr className="bg-emerald-500/10 text-xs">
                  <td colSpan={claimType !== "transportation" ? 9 : 7} className="px-3 py-2 text-right font-medium">接受金額 (不含退回行)</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700 font-bold">${approvedTotalHkd.toFixed(2)}</td>
                  <td></td>
                  {canReviewPerLine && <td></td>}
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </CardContent></Card>

      {/* Batch-level attachments only (line-level 已隨 line 顯示) */}
      {batchAttachments.length > 0 && (
        <Card><CardContent className="p-4">
          <div className="text-sm font-medium mb-2">Cover Sheet / 整包附件 ({batchAttachments.length})</div>
          <div className="space-y-1">
            {batchAttachments.map((a: any) => (
              <button key={a.id} onClick={() => openAttachment(a.storage_path)}
                className="flex items-center gap-2 w-full text-left bg-muted/30 hover:bg-muted px-3 py-2 rounded text-sm">
                <FileText size={14} className="text-primary" />
                <span className="flex-1 truncate">{a.file_name}</span>
                <span className="text-xs text-muted-foreground">{(a.size_bytes / 1024).toFixed(1)} KB</span>
                <Download size={12} className="text-muted-foreground" />
              </button>
            ))}
          </div>
        </CardContent></Card>
      )}

      {/* Actions */}
      <Card><CardContent className="p-4 space-y-3">
        <div className="text-sm font-medium">操作</div>
        {(canTeamHeadApprove || canFinalApprove || canReject) && (
          <Textarea
            placeholder="加備註 (退回必填)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="min-h-[60px] text-sm"
            data-testid="textarea-comment"
          />
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Edit draft / rejected — 草稿或退回狀態可以修改（admin/owner 可以代修同事） */}
          {(status === "draft" || status === "rejected") && (isClaimant || isSuperUser) && (
            <Button
              variant="outline"
              onClick={() => setLocation(`/claims/${claimId}/edit`)}
              disabled={processing}
              data-testid="button-edit-draft"
            >
              <FileText size={14} className="mr-1" /> {status === "rejected" ? "修改後重新提交" : "繼續修改草稿"}
            </Button>
          )}
          {/* Claimant resubmit */}
          {isClaimant && (status === "draft" || status === "rejected") && (
            <Button onClick={submitClaim} disabled={processing} data-testid="button-submit">
              <Send size={14} className="mr-1" /> 提交
            </Button>
          )}
          {/* Team head approve */}
          {canTeamHeadApprove && (
            <Button onClick={teamHeadApprove} disabled={processing} data-testid="button-team-head-approve">
              <FileCheck size={14} className="mr-1" /> Team Head 簽核
            </Button>
          )}
          {/* Final approve */}
          {canFinalApprove && (
            <Button onClick={finalApprove} disabled={processing} className="bg-emerald-600 hover:bg-emerald-700" data-testid="button-final-approve">
              <CheckCircle2 size={14} className="mr-1" /> 最終批核
            </Button>
          )}
          {/* Reject */}
          {canReject && (
            <Button variant="destructive" onClick={reject} disabled={processing} data-testid="button-reject">
              <XCircle size={14} className="mr-1" /> 退回
            </Button>
          )}
          {/* Export — 付款申請唔出 journal CSV，係喺付款申請面板直接入 NetSuite Bills */}
          {canExport && claimType !== "payment" && (
            <Button onClick={exportJournalCsv} disabled={processing} data-testid="button-export">
              <FileDown size={14} className="mr-1" /> 匯出 Journal CSV
            </Button>
          )}
          {status === "exported" && isSuperUser && claimType !== "payment" && (
            <Button variant="outline" onClick={exportJournalCsv} data-testid="button-re-export">
              <FileDown size={14} className="mr-1" /> 重新下載 CSV
            </Button>
          )}
        </div>
      </CardContent></Card>

      {/* Audit log */}
      {auditLog.length > 0 && (
        <Card><CardContent className="p-4">
          <div className="text-sm font-medium mb-3">操作紀錄</div>
          <div className="space-y-2">
            {auditLog.map((a: any) => (
              <div key={a.id} className="flex items-start gap-2 text-xs">
                <Clock size={12} className="mt-1 text-muted-foreground" />
                <div className="flex-1">
                  <div className="font-medium">{a.action} {a.from_status && a.to_status && <span className="text-muted-foreground">({a.from_status} → {a.to_status})</span>}</div>
                  {a.comment && <div className="text-muted-foreground italic">"{a.comment}"</div>}
                  <div className="text-muted-foreground">
                    {a.user_profiles?.full_name || a.user_profiles?.email || "—"} · {new Date(a.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}


