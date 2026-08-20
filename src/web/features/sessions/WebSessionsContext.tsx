import React, { createContext, useContext, useMemo } from "react";

import { useWebSessionRoster } from "./useWebSessionRoster";

type WebSessionsContextValue = ReturnType<typeof useWebSessionRoster>;

const WebSessionsContext = createContext<WebSessionsContextValue | null>(null);

export function WebSessionsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const roster = useWebSessionRoster();
  const value = useMemo(() => roster, [roster]);
  return (
    <WebSessionsContext.Provider value={value}>
      {children}
    </WebSessionsContext.Provider>
  );
}

export function useWebSessions(): WebSessionsContextValue {
  const value = useContext(WebSessionsContext);
  if (!value)
    throw new Error("useWebSessions must be used within WebSessionsProvider");
  return value;
}
