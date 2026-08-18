/**
 * Service Auth Components
 *
 * Feature-scoped UI for hosted-service authentication. The desktop shell is
 * local-first, so these controls request identity only where it is needed.
 */
import Button, { type ButtonVariant } from "@/src/components/Button";
import { LogIn, LogOut } from "lucide-react";
import React from "react";

import { useServiceAuth } from "@src/hooks/auth";

interface ServiceLoginButtonProps {
  className?: string;
  variant?: ButtonVariant;
}

export const ServiceLoginButton: React.FC<ServiceLoginButtonProps> = ({
  className,
  variant = "primary",
}) => {
  const { isAuthenticated, isLoading, login, logout } = useServiceAuth();

  if (isLoading) {
    return (
      <Button variant={variant} className={className} disabled>
        <span className="animate-pulse">Loading...</span>
      </Button>
    );
  }

  if (isAuthenticated) {
    return (
      <Button
        variant="tertiary"
        className={className}
        onClick={() => logout()}
        icon={<LogOut className="h-4 w-4" />}
      >
        Sign out
      </Button>
    );
  }

  return (
    <Button
      variant={variant}
      className={className}
      onClick={login}
      icon={<LogIn className="h-4 w-4" />}
    >
      Sign in
    </Button>
  );
};

export default ServiceLoginButton;
