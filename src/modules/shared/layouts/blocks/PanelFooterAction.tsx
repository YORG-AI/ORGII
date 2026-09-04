import type { ReactNode } from "react";

import Button from "@src/components/Button";

interface PanelFooterActionProps {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  buttonVariant?: "primary" | "secondary";
}

const PanelFooterAction = ({
  label,
  onClick,
  icon,
  buttonVariant = "primary",
}: PanelFooterActionProps) => {
  return (
    <div className="shrink-0 p-3">
      <Button
        variant={buttonVariant}
        size="large"
        icon={icon}
        long
        onClick={onClick}
      >
        {label}
      </Button>
    </div>
  );
};

export default PanelFooterAction;
