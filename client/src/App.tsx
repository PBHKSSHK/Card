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
import ClaimsPage from "@/pages/ClaimsPage";
import NewClaimPage from "@/pages/NewClaimPage";
import ClaimDetailPage from "@/pages/ClaimDetailPage";
import ApprovalInboxPage from "@/pages/ApprovalInboxPage";
import ClaimJournalExport from "@/pages/ClaimJournalExport";
import SettingsPage from "@/pages/SettingsPage";
import LoginPage from "@/pages/LoginPage";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

function SuperOnly({ component: C }: { component: React.ComponentType }) {
  const { isSuperUser, loading } = useAuth();
  if (loading) return null;
  if (!isSuperUser) {
    return (
      <div className="p-12 text-center text-muted-foreground">
        <p className="text-lg font-medium">該頁面只有 Owner / Admin 可以訪問</p>
        <p className="text-sm mt-2">如需權限請聯繫 admin</p>
      </div>
    );
  }
  return <C />;
}

function AppRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/upload" component={UploadCentre} />
        <Route path="/recon" component={ReconQueue} />
        <Route path="/exceptions" component={Exceptions} />
        {/* CSV export 同 Journal 設定 — 只有 owner/admin */}
        <Route path="/export">{() => <SuperOnly component={JournalExport} />}</Route>
        <Route path="/bundle">{() => <SuperOnly component={BundleDownload} />}</Route>
        <Route path="/report" component={BuReport} />
        <Route path="/bank-recon">{() => <SuperOnly component={BankRecon} />}</Route>
        {/* Claim Forms */}
        <Route path="/claims/inbox" component={ApprovalInboxPage} />
        <Route path="/claims/export">{() => <SuperOnly component={ClaimJournalExport} />}</Route>
        <Route path="/claims" component={ClaimsPage} />
        <Route path="/claims/new/:type" component={NewClaimPage} />
        <Route path="/claims/:id/edit" component={NewClaimPage} />
        <Route path="/claims/:id" component={ClaimDetailPage} />
        <Route path="/settings" component={SettingsPage} />
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
