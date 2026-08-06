import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/components/StatusBadge";
import { BarChart3, Building2, Layers } from "lucide-react";
import type { BuSummary } from "@shared/schema";

export default function BuReport() {
  const { data: summary, isLoading } = useQuery({
    queryKey: ["bu-report"],
    queryFn: async () => {
      const { data, error } = await supabase.from("v_bu_summary").select("*");
      if (error) throw error;
      return data as BuSummary[];
    },
  });

  // Group by entity
  const byEntity = (summary || []).reduce((acc, row) => {
    const key = row.entity_code;
    if (!acc[key]) acc[key] = { name: row.entity_name, departments: [], total: 0, confirmed: 0 };
    acc[key].departments.push(row);
    acc[key].total += Number(row.total_amount);
    acc[key].confirmed += Number(row.confirmed_amount);
    return acc;
  }, {} as Record<string, { name: string; departments: BuSummary[]; total: number; confirmed: number }>);

  const grandTotal = Object.values(byEntity).reduce((s, e) => s + e.total, 0);

  return (
    <div className="p-6 space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">BU Allocation Report</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Spending breakdown by entity and department
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : !summary || summary.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            <BarChart3 size={32} className="mx-auto mb-3 text-muted-foreground/50" />
            No allocation data yet. Process transactions and assign them to entities/departments.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-5 pb-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Grand Total</p>
                <p className="text-2xl font-semibold mt-1 tabular-nums">{formatCurrency(grandTotal)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5 pb-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Entities</p>
                <p className="text-2xl font-semibold mt-1">{Object.keys(byEntity).length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5 pb-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Departments</p>
                <p className="text-2xl font-semibold mt-1">{summary.length}</p>
              </CardContent>
            </Card>
          </div>

          {/* Entity breakdown cards */}
          {Object.entries(byEntity).map(([code, entity]) => (
            <Card key={code}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Building2 size={16} className="text-primary" />
                  {code} — {entity.name}
                  <span className="ml-auto text-muted-foreground font-normal tabular-nums">
                    {formatCurrency(entity.total)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Allocation bar */}
                {grandTotal > 0 && (
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>Share of total</span>
                      <span className="tabular-nums">{Math.round((entity.total / grandTotal) * 100)}%</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{ width: `${(entity.total / grandTotal) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                <table className="w-full table-dense">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Department</th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-2">Lines</th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-2">Total</th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-2">Confirmed</th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-2">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entity.departments.map(dept => (
                      <tr key={dept.department_code} className="border-b border-border/50 last:border-0">
                        <td className="py-2 text-sm">
                          <span className="font-medium">{dept.department_code}</span>
                          <span className="text-muted-foreground ml-1.5">{dept.department_name}</span>
                        </td>
                        <td className="py-2 text-sm text-right tabular-nums">{dept.line_count}</td>
                        <td className="py-2 text-sm text-right tabular-nums font-medium">
                          {formatCurrency(Number(dept.total_amount))}
                        </td>
                        <td className="py-2 text-sm text-right tabular-nums text-muted-foreground">
                          {formatCurrency(Number(dept.confirmed_amount))}
                        </td>
                        <td className="py-2 text-sm text-right tabular-nums text-muted-foreground">
                          {entity.total > 0 ? `${Math.round((Number(dept.total_amount) / entity.total) * 100)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
