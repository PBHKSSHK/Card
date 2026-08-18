import * as React from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider, useAuth } from "@/lib/auth";
import AppLayout from "@/components/AppLayout";
import ErrorBoundary from "@/components/ErrorBoundary";
import Dashboard from "@/pages/Dashboard";
import UploadCentre from "@/pages/UploadCentre";
import ReconQueue from "@/pages/ReconQueue";
import Exceptions from "@/pages/Exceptions";
import JournalExport from "@/pages/JournalExport";
import BundleDownload from "@/pages/BundleDownload";
import BuReport from "@/pages/BuReport";
import BankRecon from "@/pages/BankRecon";
import BankUploadCentre from "@/pages/BankUploadCentre";
import ClaimsPage from "@/pages/ClaimsPage";
import PaymentsPage from "@/pages/PaymentsPage";
import PaymentsExportPage from "@/pages/PaymentsExportPage";
import NewClaimPage from "@/pages/NewClaimPage";
import ClaimDetailPage from "@/pages/ClaimDetailPage";
import ApprovalInboxPage from "@/pages/ApprovalInboxPage";
import ClaimJournalExport from "@/pages/ClaimJournalExport";
import SettingsPage from "@/pages/SettingsPage";
import LoginPage from "@/pages/LoginPage";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

// Route 守衛：superOnly = 只限 owner/admin；module = 需要該模組使用權
// (Settings -> Users 可用模組剔選)。兩個可以同時要求。
function Gate({ component: C, superOnly, module }: {
  component: React.ComponentType;
  superOnly?: boolean;
  module?: "card" | "bank" | "claims";
}) {
  const { isSuperUser, hasModule, loading } = useAuth();
  if (loading) return null;
  if (superOnly && !isSuperUser) {
    return (
      <div className="p-12 text-center text-muted-foreground">
        <p className="text-lg font-medium">該頁面只有 Owner / Admin 可以訪問</p>
        <p className="text-sm mt-2">如需權限請聯繫 admin</p>
      </div>
    );
  }
  if (module && !hasModule(module)) {
    return (
      <div className="p-12 text-center text-muted-foreground">
        <p className="text-lg font-medium">你冇呢個模組嘅使用權限</p>
        <p className="text-sm mt-2">如需開通請聯繫 admin（Settings → Users → 可用模組）</p>
      </div>
    );
  }
  return <C />;
}

// 兩個審批 Inbox — claims (日常駛費+交通費) 同 付款申請 分開
const ClaimsInbox = () => <ApprovalInboxPage family="claims" />;
const PaymentsInbox = () => <ApprovalInboxPage family="payment" />;

function AppRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        {/* Credit card 模組 */}
        <Route path="/upload">{() => <Gate module="card" component={UploadCentre} />}</Route>
        <Route path="/recon">{() => <Gate module="card" component={ReconQueue} />}</Route>
        <Route path="/exceptions">{() => <Gate module="card" component={Exceptions} />}</Route>
        {/* CSV export 同 Journal 設定 — 只有 owner/admin */}
        <Route path="/export">{() => <Gate module="card" superOnly component={JournalExport} />}</Route>
        <Route path="/bundle">{() => <Gate module="card" superOnly component={BundleDownload} />}</Route>
        <Route path="/report">{() => <Gate module="card" component={BuReport} />}</Route>
        {/* Bank 模組 (owner/admin only) */}
        <Route path="/bank-upload">{() => <Gate module="bank" superOnly component={BankUploadCentre} />}</Route>
        <Route path="/bank-recon">{() => <Gate module="bank" superOnly component={BankRecon} />}</Route>
        {/* Claims 模組 — claims 同付款申請各自有 inbox / export */}
        <Route path="/payments">{() => <Gate module="claims" component={PaymentsPage} />}</Route>
        <Route path="/payments/inbox">{() => <Gate module="claims" component={PaymentsInbox} />}</Route>
        <Route path="/payments/export">{() => <Gate module="claims" superOnly component={PaymentsExportPage} />}</Route>
        {/* 付款申請詳情/修改用自己嘅 URL — sidebar 先識亮「付款申請」 */}
        <Route path="/payments/:id/edit">{() => <Gate module="claims" component={NewClaimPage} />}</Route>
        <Route path="/payments/:id">{() => <Gate module="claims" component={ClaimDetailPage} />}</Route>
        <Route path="/claims/inbox">{() => <Gate module="claims" component={ClaimsInbox} />}</Route>
        <Route path="/claims/export">{() => <Gate module="claims" superOnly component={ClaimJournalExport} />}</Route>
        <Route path="/claims">{() => <Gate module="claims" component={ClaimsPage} />}</Route>
        <Route path="/claims/new/:type">{() => <Gate module="claims" component={NewClaimPage} />}</Route>
        <Route path="/claims/:id/edit">{() => <Gate module="claims" component={NewClaimPage} />}</Route>
        <Route path="/claims/:id">{() => <Gate module="claims" component={ClaimDetailPage} />}</Route>
        {/* Settings — 只限 Owner/Admin (BU user 唔可以睇) */}
        <Route path="/settings">{() => <Gate superOnly component={SettingsPage} />}</Route>
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function AuthGate() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  return (
    <Router hook={useHashLocation}>
      <AppRouter />
    </Router>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThemeProvider>
            <AuthProvider>
              <Toaster />
              <AuthGate />
            </AuthProvider>
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
