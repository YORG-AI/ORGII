import React from "react";

import type { ReviewCommentSeverity } from "@src/api/http/project";
import AnyIcon from "@src/components/AnyIcon";
import {
  Alert01Icon,
  BulbIcon,
  CancelCircleIcon,
  type IconSvgElement,
  ThumbsUpIcon,
} from "@src/icons";

const REVIEW_SEVERITY_CONFIG: Record<
  ReviewCommentSeverity,
  { icon: IconSvgElement; name: string; className: string }
> = {
  error: {
    icon: CancelCircleIcon,
    name: "xcircle",
    className: "text-danger-6",
  },
  warning: {
    icon: Alert01Icon,
    name: "alert-triangle",
    className: "text-warning-6",
  },
  suggestion: {
    icon: BulbIcon,
    name: "lightbulb",
    className: "text-primary-6",
  },
  praise: {
    icon: ThumbsUpIcon,
    name: "thumbs-up",
    className: "text-success-6",
  },
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
  return (
    <AnyIcon
      icon={config.icon}
      data-icon={config.name}
      size={size}
      className={`shrink-0 ${config.className} ${className}`}
    />
  );
};

export default ReviewSeverityIcon;
