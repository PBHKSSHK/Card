import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, formatCurrency } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import AssignModal from "@/components/AssignModal";
import SplitModal from "@/components/SplitModal";
import { Button } from "@/components/ui/button";
import type { TransactionFull } from "@shared/schema";
import { AlertTriangle } from "lucide-react";

export default function Exceptions() {
  const [selectedTxn, setSelectedTxn] = useState<TransactionFull | null>(null);
  const [modalType, setModalType] = useState<"assign" | "split" | null>(null);
  const queryClient = useQueryClient();

  const { data: transactions, isLoading } = useQuery({
    queryKey: ["exceptions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_transactions_full")
        .select("*")
        .in("match_status", ["unmatched", "exception"])
        .order("txn_date", { ascending: false });
      if (error) throw error;
      return data as TransactionFull[];
    },
  });

  return (
    <div className="p-6 space-y-4 max-w-[1400px]">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Exception Review</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {transactions?.length ?? 0} unmatched or exception transactions requiring attention
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : !transactions || transactions.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground text-sm flex flex-col items-center gap-2">
              <AlertTriangle size={24} className="text-muted-foreground/50" />
              No exceptions — all transactions are matched or pending.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-dense">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Date</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Merchant</th>
                    <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2.5">Amount</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Cardholder</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Status</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2.5">Notes</th>
                    <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2.5">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(txn => (
                    <tr key={txn.transaction_id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                      <td className="px-3 py-2 text-sm tabular-nums">{txn.txn_date}</td>
                      <td className="px-3 py-2 text-sm font-medium">{txn.merchant}</td>
                      <td className="px-3 py-2 text-sm text-right tabular-nums font-medium">
                        {formatCurrency(txn.amount_hkd ?? txn.amount)}
                      </td>
                      <td className="px-3 py-2 text-sm text-muted-foreground">
                        {txn.card_last4 || '—'}
                      </td>
                      <td className="px-3 py-2"><StatusBadge status={txn.match_status} /></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground max-w-[200px] truncate">
                        {txn.match_notes || '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex gap-1 justify-end">
                          <Button
                            variant="ghost" size="sm" className="text-xs h-7 px-2"
                            onClick={() => { setSelectedTxn(txn); setModalType("assign"); }}
                          >Assign</Button>
                          <Button
                            variant="ghost" size="sm" className="text-xs h-7 px-2"
                            onClick={() => { setSelectedTxn(txn); setModalType("split"); }}
                          >Split</Button>
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

      {selectedTxn && modalType === "assign" && (
        <AssignModal
          transaction={selectedTxn}
          onClose={() => { setSelectedTxn(null); setModalType(null); }}
          onSaved={() => {
            setSelectedTxn(null); setModalType(null);
            queryClient.invalidateQueries({ queryKey: ["exceptions"] });
          }}
        />
      )}
      {selectedTxn && modalType === "split" && (
        <SplitModal
          transaction={selectedTxn}
          onClose={() => { setSelectedTxn(null); setModalType(null); }}
          onSaved={() => {
            setSelectedTxn(null); setModalType(null);
            queryClient.invalidateQueries({ queryKey: ["exceptions"] });
          }}
        />
      )}
    </div>
  );
}
