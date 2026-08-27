import { AlertTriangle, Lightbulb, ThumbsUp, XCircle } from "lucide-react";
import React from "react";

import type { ReviewCommentSeverity } from "@src/api/http/project";

const REVIEW_SEVERITY_CONFIG: Record<
  ReviewCommentSeverity,
  { icon: typeof XCircle; className: string }
> = {
  error: { icon: XCircle, className: "text-danger-6" },
  warning: { icon: AlertTriangle, className: "text-warning-6" },
  suggestion: { icon: Lightbulb, className: "text-primary-6" },
  praise: { icon: ThumbsUp, className: "text-success-6" },
};

interface ReviewSeverityIconProps {
  severity: ReviewCommentSeverity;
  size?: number;
  className?: string;
}

const ReviewSeverityIcon: React.FC<ReviewSeverityIconProps> = ({
  severity,
  size = 12,
  className = "",
}) => {
  const config = REVIEW_SEVERITY_CONFIG[severity];
  const Icon = config.icon;
  return (
    <Icon size={size} className={`shrink-0 ${config.className} ${className}`} />
  );
};

export default ReviewSeverityIcon;
