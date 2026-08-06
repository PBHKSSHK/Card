import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Building2, Layers, BookOpen, CreditCard, Key, CheckCircle2, Users, UserPlus, Loader2, AlertCircle, Database, ChevronRight, FolderKanban, Tags } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import type { NsChartOfAccount, NsSubsidiary, NsDepartment, NsEmployee, NsVendor, NsCustomer, NsCreditCardAccount, NsProjectCode, ExpenseCategory } from "@shared/schema";

export default function SettingsPage() {
  const { isSuperUser: isAdmin } = useAuth();

  const { data: entities, isLoading: loadingEntities } = useQuery({
    queryKey: ["entities"],
    queryFn: async () => {
      const { data, error } = await supabase.from("entities").select("*").order("code");
      if (error) throw error;
      return data;
    },
  });

  const { data: departments, isLoading: loadingDepts } = useQuery({
    queryKey: ["departments"],
    queryFn: async () => {
      const { data, error } = await supabase.from("departments").select("*, entities(code, name)").order("code");
      if (error) throw error;
      return data;
    },
  });

  const { data: rules, isLoading: loadingRules } = useQuery({
    queryKey: ["matching-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matching_rules")
        .select("*, entities(code), departments(code)")
        .eq("is_active", true)
        .order("priority");
      if (error) throw error;
      return data;
    },
  });

  const { data: settings, isLoading: loadingSettings } = useQuery({
    queryKey: ["journal-settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("journal_settings").select("*").single();
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="p-6 space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Entity, department, matching rule, and user configuration</p>
      </div>

      <Tabs defaultValue="entities">
        <TabsList>
          <TabsTrigger value="entities"><Building2 size={14} className="mr-1.5" /> Entities</TabsTrigger>
          <TabsTrigger value="departments"><Layers size={14} className="mr-1.5" /> Departments</TabsTrigger>
          <TabsTrigger value="rules"><BookOpen size={14} className="mr-1.5" /> Matching Rules</TabsTrigger>
          <TabsTrigger value="journal"><CreditCard size={14} className="mr-1.5" /> Journal</TabsTrigger>
          <TabsTrigger value="expense-categories"><Tags size={14} className="mr-1.5" /> Expense Categories</TabsTrigger>
          <TabsTrigger value="project-codes"><FolderKanban size={14} className="mr-1.5" /> Project Codes</TabsTrigger>
          <TabsTrigger value="employees"><Users size={14} className="mr-1.5" /> Employees</TabsTrigger>
          <TabsTrigger value="netsuite"><Database size={14} className="mr-1.5" /> NetSuite</TabsTrigger>
          <TabsTrigger value="ai"><Key size={14} className="mr-1.5" /> AI / API</TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="users"><Users size={14} className="mr-1.5" /> Users</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="entities">
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Entities</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingEntities ? (
                <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : (
                <table className="w-full table-dense">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Code</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Name</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entities?.map(e => (
                      <tr key={e.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2 text-sm font-medium">{e.code}</td>
                        <td className="py-2 text-sm">{e.name}</td>
                        <td className="py-2 text-sm text-muted-foreground">{new Date(e.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="departments">
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Departments</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingDepts ? (
                <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : (
                <table className="w-full table-dense">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Entity</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Code</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Name</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">DR Account</th>
                    </tr>
                  </thead>
                  <tbody>
                    {departments?.map(d => (
                      <tr key={d.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2 text-sm font-medium">{(d as any).entities?.code || '—'}</td>
                        <td className="py-2 text-sm">{d.code}</td>
                        <td className="py-2 text-sm">{d.name}</td>
                        <td className="py-2 text-sm font-mono text-muted-foreground">{d.dr_account}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules">
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Active Matching Rules</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingRules ? (
                <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : (
                <table className="w-full table-dense">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Pattern</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Entity</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Dept</th>
                      <th className="text-right text-xs font-medium text-muted-foreground py-2">Priority</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules?.map(r => (
                      <tr key={r.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2 text-sm font-mono">{r.keyword}</td>
                        <td className="py-2 text-sm">{(r as any).entities?.code || '—'}</td>
                        <td className="py-2 text-sm">{(r as any).departments?.code || '—'}</td>
                        <td className="py-2 text-sm text-right tabular-nums">{r.priority}</td>
                        <td className="py-2 text-sm text-muted-foreground">{r.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="journal">
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Journal Settings</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingSettings ? (
                <Skeleton className="h-32 w-full" />
              ) : settings ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <SettingRow label="CR Account (Card Payable)" value={settings.cr_account} />
                  <SettingRow label="Default Currency" value={settings.default_currency} />
                  <SettingRow label="Date Tolerance (days)" value={String(settings.date_tolerance_days)} />
                  <SettingRow label="Fuzzy Threshold" value={String(settings.fuzzy_threshold)} />
                  <SettingRow label="Amount Tolerance (%)" value={String(settings.amount_tolerance_pct)} />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expense-categories">
          <ExpenseCategoriesTab />
        </TabsContent>

        <TabsContent value="project-codes">
          <ProjectCodesTab />
        </TabsContent>

        <TabsContent value="employees">
          <EmployeesTab />
        </TabsContent>

        <TabsContent value="netsuite">
          <NetSuiteReferenceData />
        </TabsContent>

        <TabsContent value="ai">
          <ApiKeySettings />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="users">
            <UserManagement />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ---- Expense Categories Tab ----

function ExpenseCategoriesTab() {
  const { isSuperUser: isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: categories = [], isLoading } = useQuery<ExpenseCategory[]>({
    queryKey: ["expense-categories-admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return data as ExpenseCategory[];
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("expense_categories")
        .update({ is_active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expense-categories-admin"] });
      queryClient.invalidateQueries({ queryKey: ["expense_categories"] });
      toast({ title: "Updated" });
    },
    onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">Expense Categories</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Invoice 上載時使用的費用類別，會自動對應 NetSuite 科目號。如公司未設立該科目，將 fallback 至 81000090 Sundry Expenses。
            </p>
          </div>
          <Badge variant="secondary">{categories.length} categories</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : categories.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <AlertCircle className="mx-auto mb-2 text-amber-500" size={24} />
            尚未導入 expense categories 。請在 Supabase SQL editor 執行 migration。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium text-xs">#</th>
                  <th className="px-3 py-2 font-medium text-xs">Category</th>
                  <th className="px-3 py-2 font-medium text-xs">English</th>
                  <th className="px-3 py-2 font-medium text-xs">NS Account</th>
                  <th className="px-3 py-2 font-medium text-xs">Key</th>
                  <th className="px-3 py-2 font-medium text-xs text-center">Active</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <tr key={cat.id} className="border-t border-border/50 hover:bg-muted/30">
                    <td className="px-3 py-2 text-muted-foreground tabular-nums">{cat.sort_order}</td>
                    <td className="px-3 py-2 font-medium">{cat.label_zh}</td>
                    <td className="px-3 py-2 text-muted-foreground">{cat.label_en}</td>
                    <td className="px-3 py-2 tabular-nums font-mono text-xs">{cat.ns_account_number}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{cat.category_key}</td>
                    <td className="px-3 py-2 text-center">
                      {isAdmin ? (
                        <Button
                          size="sm"
                          variant={cat.is_active ? "default" : "outline"}
                          className="h-7 px-2 text-xs"
                          onClick={() => toggleActive.mutate({ id: cat.id, is_active: !cat.is_active })}
                          disabled={toggleActive.isPending}
                          data-testid={`button-toggle-${cat.category_key}`}
                        >
                          {cat.is_active ? "Active" : "Inactive"}
                        </Button>
                      ) : (
                        <Badge variant={cat.is_active ? "default" : "secondary"}>
                          {cat.is_active ? "Active" : "Inactive"}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Project Codes Tab ----

function ProjectCodesTab() {
  const [filter, setFilter] = useState("");
  const { data, isLoading } = useQuery<NsProjectCode[]>({
    queryKey: ["ns-project-codes"],
    queryFn: async () => {
      let allData: NsProjectCode[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data: page, error } = await supabase
          .from("ns_project_codes")
          .select("*")
          .order("project_id")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        allData = allData.concat(page as NsProjectCode[]);
        if (page.length < pageSize) break;
        from += pageSize;
      }
      return allData;
    },
  });

  const filtered = data?.filter(r => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return r.project_id.toLowerCase().includes(q)
      || r.project_name.toLowerCase().includes(q)
      || (r.customer_name || '').toLowerCase().includes(q)
      || (r.entity_name || '').toLowerCase().includes(q)
      || (r.charge_to || '').toLowerCase().includes(q);
  });

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Project Codes</CardTitle>
          <Badge variant="secondary" className="text-xs font-mono">{data?.length ?? 0} rows</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Input
          placeholder="Search project ID, name, customer, entity..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="mb-3 text-sm h-9 max-w-sm"
        />
        {isLoading ? (
          <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : (
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Project ID</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Project Name</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Entity</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Charge To</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Customer</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Subsidiary</th>
                </tr>
              </thead>
              <tbody>
                {filtered?.map(r => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-1.5 text-sm font-mono font-medium">{r.project_id}</td>
                    <td className="px-3 py-1.5 text-sm max-w-[300px] truncate" title={r.project_name}>{r.project_name}</td>
                    <td className="px-3 py-1.5 text-sm">{r.entity_name}</td>
                    <td className="px-3 py-1.5 text-sm">
                      {r.charge_to ? <Badge variant="outline" className="text-xs font-mono">{r.charge_to}</Badge> : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-sm text-muted-foreground max-w-[200px] truncate" title={r.customer_name || ''}>{r.customer_name || '—'}</td>
                    <td className="px-3 py-1.5 text-sm text-muted-foreground text-xs">{r.subsidiary || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Employees Tab ----

function EmployeesTab() {
  const [filter, setFilter] = useState("");
  const { data, isLoading } = useQuery<NsEmployee[]>({
    queryKey: ["ns-employees-full"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ns_employees").select("*").order("name");
      if (error) throw error;
      return data as NsEmployee[];
    },
  });

  const filtered = data?.filter(r => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return r.name.toLowerCase().includes(q)
      || r.code.toLowerCase().includes(q)
      || (r.email || '').toLowerCase().includes(q)
      || (r.department || '').toLowerCase().includes(q)
      || r.subsidiary.toLowerCase().includes(q)
      || (r.charge_to || '').toLowerCase().includes(q);
  });

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Employees</CardTitle>
          <Badge variant="secondary" className="text-xs font-mono">{data?.length ?? 0} rows</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Input
          placeholder="Search name, code, email, department..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="mb-3 text-sm h-9 max-w-sm"
        />
        {isLoading ? (
          <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : (
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Code</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Name</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Email</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Subsidiary</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Department</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Charge To</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Login</th>
                </tr>
              </thead>
              <tbody>
                {filtered?.map(r => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-1.5 text-sm font-mono font-medium">{r.code}</td>
                    <td className="px-3 py-1.5 text-sm">{r.name}</td>
                    <td className="px-3 py-1.5 text-sm text-muted-foreground">{r.email || '—'}</td>
                    <td className="px-3 py-1.5 text-sm text-xs">{r.subsidiary}</td>
                    <td className="px-3 py-1.5 text-sm text-muted-foreground">{r.department || '—'}</td>
                    <td className="px-3 py-1.5 text-sm">
                      {r.charge_to ? <Badge variant="outline" className="text-xs font-mono">{r.charge_to}</Badge> : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-sm">{r.login_access ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- NetSuite Reference Data ----

function NsSection<T>({ title, queryKey, tableName, rowCount, children }: {
  title: string;
  queryKey: string;
  tableName: string;
  rowCount: number;
  children: (data: T[]) => ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery<T[]>({
    queryKey: [queryKey],
    queryFn: async () => {
      const { data, error } = await supabase.from(tableName).select("*");
      if (error) throw error;
      return data as T[];
    },
    enabled: open,
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center justify-between px-4 py-3 rounded-md border border-border hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <ChevronRight size={14} className={`text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
            <span className="text-sm font-medium">{title}</span>
          </div>
          <Badge variant="secondary" className="text-xs font-mono">{rowCount}</Badge>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 border border-border rounded-md overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : data ? (
            <div className="overflow-x-auto">
              {children(data)}
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function NetSuiteReferenceData() {
  return (
    <div className="mt-4 space-y-2">
      <NsSection<NsChartOfAccount> title="Chart of Accounts" queryKey="ns-chart-of-accounts" tableName="ns_chart_of_accounts" rowCount={197}>
        {(data) => (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Account #</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Account Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Entity</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Subsidiary</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Type</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {data.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-1.5 text-sm font-mono">{r.account_number}</td>
                  <td className="px-4 py-1.5 text-sm">{r.account_name}</td>
                  <td className="px-4 py-1.5 text-sm">{r.entity_code ? <Badge variant="outline" className="text-xs font-mono">{r.entity_code}</Badge> : '—'}</td>
                  <td className="px-4 py-1.5 text-sm text-muted-foreground text-xs">{r.subsidiary || '—'}</td>
                  <td className="px-4 py-1.5 text-sm text-muted-foreground">{r.account_type || '—'}</td>
                  <td className="px-4 py-1.5 text-sm">{r.is_active ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </NsSection>

      <NsSection<NsSubsidiary> title="Subsidiaries" queryKey="ns-subsidiaries" tableName="ns_subsidiaries" rowCount={6}>
        {(data) => (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Code</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">IC AR Account</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">IC AP Account</th>
              </tr>
            </thead>
            <tbody>
              {data.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-1.5 text-sm font-mono font-medium">{r.short_code}</td>
                  <td className="px-4 py-1.5 text-sm">{r.name}</td>
                  <td className="px-4 py-1.5 text-sm font-mono text-muted-foreground">{r.intercompany_ar_account || '—'}</td>
                  <td className="px-4 py-1.5 text-sm font-mono text-muted-foreground">{r.intercompany_ap_account || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </NsSection>

      <NsSection<NsDepartment> title="Departments" queryKey="ns-departments" tableName="ns_departments" rowCount={23}>
        {(data) => (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">ID</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Entity</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Charge To</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Subsidiary</th>
              </tr>
            </thead>
            <tbody>
              {data.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-1.5 text-sm font-mono">{r.internal_id}</td>
                  <td className="px-4 py-1.5 text-sm">{r.name}</td>
                  <td className="px-4 py-1.5 text-sm">{r.entity_code ? <Badge variant="outline" className="text-xs font-mono">{r.entity_code}</Badge> : '—'}</td>
                  <td className="px-4 py-1.5 text-sm font-mono text-muted-foreground">{r.charge_to || '—'}</td>
                  <td className="px-4 py-1.5 text-sm text-muted-foreground text-xs">{r.subsidiary_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </NsSection>

      <NsSection<NsEmployee> title="Employees" queryKey="ns-employees" tableName="ns_employees" rowCount={37}>
        {(data) => (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Code</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Email</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Subsidiary</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Department</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Charge To</th>
              </tr>
            </thead>
            <tbody>
              {data.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-1.5 text-sm font-mono font-medium">{r.code}</td>
                  <td className="px-4 py-1.5 text-sm">{r.name}</td>
                  <td className="px-4 py-1.5 text-sm text-muted-foreground">{r.email || '—'}</td>
                  <td className="px-4 py-1.5 text-sm text-xs">{r.subsidiary}</td>
                  <td className="px-4 py-1.5 text-sm text-muted-foreground">{r.department || '—'}</td>
                  <td className="px-4 py-1.5 text-sm">{r.charge_to ? <Badge variant="outline" className="text-xs font-mono">{r.charge_to}</Badge> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </NsSection>

      <NsSection<NsVendor> title="Vendors" queryKey="ns-vendors" tableName="ns_vendors" rowCount={9}>
        {(data) => (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Code</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Intercompany</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Related Subsidiary</th>
              </tr>
            </thead>
            <tbody>
              {data.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-1.5 text-sm font-mono font-medium">{r.code}</td>
                  <td className="px-4 py-1.5 text-sm">{r.name}</td>
                  <td className="px-4 py-1.5 text-sm">
                    {r.is_intercompany ? (
                      <Badge variant="outline" className="text-xs">IC</Badge>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-1.5 text-sm text-muted-foreground">{r.related_subsidiary || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </NsSection>

      <NsSection<NsCustomer> title="Customers" queryKey="ns-customers" tableName="ns_customers" rowCount={6}>
        {(data) => (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Code</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Intercompany</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Related Subsidiary</th>
              </tr>
            </thead>
            <tbody>
              {data.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-1.5 text-sm font-mono font-medium">{r.code}</td>
                  <td className="px-4 py-1.5 text-sm">{r.name}</td>
                  <td className="px-4 py-1.5 text-sm">
                    {r.is_intercompany ? (
                      <Badge variant="outline" className="text-xs">IC</Badge>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-1.5 text-sm text-muted-foreground">{r.related_subsidiary || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </NsSection>

      <NsSection<NsCreditCardAccount> title="Credit Card Accounts" queryKey="ns-credit-card-accounts" tableName="ns_credit_card_accounts" rowCount={5}>
        {(data) => (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Account #</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Cardholder</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Card ID</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Bank</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">Subsidiary</th>
              </tr>
            </thead>
            <tbody>
              {data.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-1.5 text-sm font-mono">{r.account_number}</td>
                  <td className="px-4 py-1.5 text-sm">{r.cardholder_name}</td>
                  <td className="px-4 py-1.5 text-sm font-mono text-muted-foreground">{r.card_identifier}</td>
                  <td className="px-4 py-1.5 text-sm">{r.bank}</td>
                  <td className="px-4 py-1.5 text-sm">{r.subsidiary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </NsSection>
    </div>
  );
}

// ---- User Management (Owner / Admin only) ----

type UserRoleOpt = "owner" | "admin" | "bu_user";
const ALL_ENTITIES = ["PBHK", "704", "CLS", "SSHK", "JM", "EXT", "JS"] as const;

function UserManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<UserRoleOpt>("bu_user");
  const [newScope, setNewScope] = useState<string[]>([]);

  const { data: users, isLoading } = useQuery({
    queryKey: ["user-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("user_id, email, full_name, role, entity_scope, created_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as {
        user_id: string;
        email: string;
        full_name: string | null;
        role: UserRoleOpt;
        entity_scope: string[] | null;
        created_at: string;
      }[];
    },
  });

  // 採用 Magic Link—經 Edge Function `invite-user` 創 auth user 跨 send invite 郵。
  // 如果未部屍 edge function，對友 fallback 用 admin 提供嘅同事 email 入 placeholder profile 后
  // 叫佢自己去 login page input email 各自拂 magic link。
  const inviteUserMutation = useMutation({
    mutationFn: async () => {
      if (!newEmail) throw new Error("Email 必填");
      const emailClean = newEmail.trim().toLowerCase();

      // Send Magic Link — 這個等同 invite + login
      const { error } = await supabase.auth.signInWithOtp({
        email: emailClean,
        options: {
          emailRedirectTo: window.location.origin,
          // shouldCreateUser 預設 true
        },
      });
      if (error) throw error;

      // 等一下，讓 supabase 生成 auth.users row (signInWithOtp 會创 user 但未 confirm)。
      // 但 user_profiles trigger 田於 supabase email signup 只是在 user confirm email 之後織太會插人。
      // 所以我這嘅 upsert 主動插以便結果 admin panel。
      // 由於沒 service-role token，我門能 query auth.users，佯可是 insert 一個 placeholder profile 部兩上入 email
      // -> trigger 未 tick。我提示 admin 在 user 首次 login 後可以入隨股改 role+scope.

      return { emailClean };
    },
    onSuccess: async ({ emailClean }) => {
      // 到這裡 Magic Link 已 sent。但我 admin panel 需要記住 預定 role+scope。
      // Workaround: 在 user_profiles 裡 upsert 一條 pending record。
      // user_id 未部生成（沒沒 user confirm), 所以 fk 會失敗。
      // 跨 reality: 我門 ON CONFLICT 反為織太。
      //
      // 完完全全 acceptable: 該 user 首次 login 足 ~5s，trigger 拍入預設 role+scope (依 email)。
      // 如果 email 不在 seed list，門入 bu_user + empty scope—讓 admin 接著手動 set。

      // 推 toast 提示 admin：invite 已寄出，如需 custom role/scope 請等 user 首次 login 後在台上改。
      const isInSeed = [
        "alex@sshk.ltd", "nok@sshk.ltd", "rex@pbhk.info", "kenneth@clsgarage.com",
        "yannese.lo@pbhk.info", "susanna.lam@photoblog.hk",
        "kitman.choi@clsgarage.com", "mabel.tan@clsgarage.com",
        "maggie.kwan@pbhk.info", "fornia.lung@sshk.ltd", "to.fok@sshk.ltd",
        "alex.lee@jervoism.com", "tracy.tsang@jervoism.com",
      ].includes(emailClean);

      setNewEmail(""); setNewName("");
      setNewRole("bu_user"); setNewScope([]);
      queryClient.invalidateQueries({ queryKey: ["user-profiles"] });
      toast({
        title: "Magic Link 已寄出",
        description: isInSeed
          ? `${emailClean} click 郵件連結後會自動拍 Role + Scope`
          : `${emailClean} 首次 login 後會設為 bu_user。請在台上改 Role + Scope。`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Invite 失敗", description: err.message, variant: "destructive" });
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: async ({ user_id, patch }: { user_id: string; patch: Partial<{ role: UserRoleOpt; entity_scope: string[]; full_name: string }> }) => {
      const { error } = await supabase.from("user_profiles").update(patch).eq("user_id", user_id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-profiles"] });
      toast({ title: "已更新" });
    },
    onError: (err: Error) => {
      toast({ title: "更新失敗", description: err.message, variant: "destructive" });
    },
  });

  const roleBadge = (r: UserRoleOpt) => {
    if (r === "owner") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    if (r === "admin") return "bg-primary/10 text-primary";
    return "bg-muted text-muted-foreground";
  };

  const toggleScope = (arr: string[], code: string) =>
    arr.includes(code) ? arr.filter(x => x !== code) : [...arr, code];

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">User Management</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Existing users */}
        {isLoading ? (
          <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full table-dense text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground py-2">Name</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2">Email</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2">Role</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2">Entity Scope</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {users?.map(u => {
                const scope = u.entity_scope || [];
                return (
                <tr key={u.user_id} className="border-b border-border/50 last:border-0 align-top">
                  <td className="py-2 font-medium">{u.full_name || "—"}</td>
                  <td className="py-2 text-muted-foreground">{u.email}</td>
                  <td className="py-2">
                    <select
                      value={u.role}
                      onChange={(e) => updateUserMutation.mutate({
                        user_id: u.user_id,
                        patch: {
                          role: e.target.value as UserRoleOpt,
                          ...(e.target.value !== "bu_user" ? { entity_scope: [] } : {}),
                        }
                      })}
                      className={`text-xs px-2 py-0.5 rounded-full bg-transparent border-0 cursor-pointer ${roleBadge(u.role)}`}
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="bu_user">bu_user</option>
                    </select>
                  </td>
                  <td className="py-2">
                    {u.role !== "bu_user" ? (
                      <span className="text-xs text-muted-foreground">全部</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {ALL_ENTITIES.map(code => (
                          <button
                            key={code}
                            onClick={() => updateUserMutation.mutate({
                              user_id: u.user_id,
                              patch: { entity_scope: toggleScope(scope, code) }
                            })}
                            className={`text-[11px] px-2 py-0.5 rounded border ${
                              scope.includes(code)
                                ? "bg-primary/10 border-primary/40 text-primary"
                                : "bg-transparent border-border text-muted-foreground hover:bg-muted"
                            }`}
                          >
                            {code}
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-muted-foreground text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                </tr>
              );})}
            </tbody>
          </table>
          </div>
        )}

        {/* Add new user */}
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserPlus size={14} /> Add New User
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Name (選填)</Label>
              <Input placeholder="例如 Kitman Choi" value={newName} onChange={(e) => setNewName(e.target.value)} className="text-sm h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email</Label>
              <Input type="email" placeholder="kitman.choi@clsgarage.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="text-sm h-9" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Role</Label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as UserRoleOpt)}
                className="w-full h-9 px-2 text-sm border border-border rounded-md bg-background"
              >
                <option value="owner">owner — 老闆 full access</option>
                <option value="admin">admin — full access + 管 user</option>
                <option value="bu_user">bu_user — 只見自己 entity</option>
              </select>
            </div>
            {newRole === "bu_user" && (
              <div className="space-y-1">
                <Label className="text-xs">Entity Scope</Label>
                <div className="flex flex-wrap gap-1 h-9 items-center">
                  {ALL_ENTITIES.map(code => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setNewScope(toggleScope(newScope, code))}
                      className={`text-[11px] px-2 py-1 rounded border ${
                        newScope.includes(code)
                          ? "bg-primary/10 border-primary/40 text-primary"
                          : "bg-transparent border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {code}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Button
            size="sm"
            onClick={() => inviteUserMutation.mutate()}
            disabled={!newEmail || inviteUserMutation.isPending}
          >
            {inviteUserMutation.isPending ? (
              <><Loader2 className="animate-spin mr-1" size={14} /> 發送中...</>
            ) : (
              <><UserPlus size={14} className="mr-1" /> 發送 Magic Link</>
            )}
          </Button>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            取代 password — 系統會 send 一個登入連結到同事 inbox，佢 click 入部會自動登入。<br />
            seed list 內面嘅 14 個 email (alex@sshk / kitman.choi / maggie.kwan / susanna.lam ...) 首次 login 時會自動拍 Role + Scope。其他 email 預設 bu_user + 空 scope，你請在上面 list 手動調。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ApiKeySettings() {
  const { toast } = useToast();
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("cardrecon_api_key") || "";
    setApiKey(stored);
  }, []);

  const handleSave = () => {
    if (apiKey.trim()) {
      localStorage.setItem("cardrecon_api_key", apiKey.trim());
    } else {
      localStorage.removeItem("cardrecon_api_key");
    }
    setSaved(true);
    toast({ title: "API key saved", description: "Key stored in browser (local only)." });
    setTimeout(() => setSaved(false), 2000);
  };

  const masked = apiKey ? apiKey.slice(0, 10) + "..." + apiKey.slice(-4) : "";

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">AI Document Parsing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Used by Upload Centre to parse PDF/image documents into structured data.
          Supports OpenAI and OpenRouter keys.
        </p>
        <div className="space-y-2">
          <Label htmlFor="api-key" className="text-sm">API Key</Label>
          <div className="flex gap-2">
            <Input
              id="api-key"
              type="password"
              placeholder="sk-... or sk-or-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
            <Button onClick={handleSave} size="sm" className="flex-shrink-0">
              {saved ? <><CheckCircle2 size={14} className="mr-1" /> Saved</> : "Save"}
            </Button>
          </div>
          {apiKey && (
            <p className="text-xs text-muted-foreground">Current: {masked}</p>
          )}
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <p>Key is stored in your browser only (localStorage) and sent to the Edge Function per request.</p>
          <p>OpenRouter keys (sk-or-...) route to openrouter.ai. OpenAI keys (sk-...) route to api.openai.com.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-md p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium mt-0.5 font-mono">{value}</p>
    </div>
  );
}
