// ============================================
// EmptyState Component
// ============================================
import React from "react";

import { Placeholder } from "@src/components/Placeholder";

// ============================================
// Component
// ============================================

const EmptyState: React.FC = () => {
  return (
    <Placeholder
      variant="empty"
      title="No API calls yet"
      subtitle="API calls will appear here"
    />
  );
};

export default EmptyState;
