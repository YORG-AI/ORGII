import { Menu, X } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";

import Button from "@src/components/Button";
import { DEFAULT_SIDEBAR_WIDTH } from "@src/store/ui/sidebarAtom";

import { WebSessionSidebar } from "./WebSessionSidebar";

export function WebShell() {
  const { t } = useTranslation("navigation");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 bg-bg-2 text-text-1">
      <aside className="hidden h-full min-h-0 shrink-0 border-r border-border-2 xl:block">
        <WebSessionSidebar />
      </aside>

      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 flex xl:hidden">
          <Button
            appearance="ghost"
            className="absolute inset-0 h-full w-full rounded-none bg-black/30"
            aria-label={t("common:actions.close", "Close")}
            onClick={() => setMobileSidebarOpen(false)}
          />
          <aside
            className="relative h-full min-h-0 shrink-0 overflow-hidden bg-bg-1 shadow-xl"
            style={{ width: DEFAULT_SIDEBAR_WIDTH }}
          >
            <WebSessionSidebar onNavigate={() => setMobileSidebarOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center border-b border-border-2 bg-pane-raised px-2 xl:hidden">
          <Button
            iconOnly
            size="mini"
            appearance="ghost"
            icon={mobileSidebarOpen ? <X size={16} /> : <Menu size={16} />}
            title={t("web.sessionsNav")}
            aria-label={t("web.sessionsNav")}
            onClick={() => setMobileSidebarOpen((open) => !open)}
          />
          <span className="ml-2 text-sm font-semibold">{t("web.title")}</span>
        </header>
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
