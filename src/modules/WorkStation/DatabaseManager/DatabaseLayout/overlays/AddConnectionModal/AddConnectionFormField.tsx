import React from "react";

import Input, { InputProps } from "@src/components/Input";

interface AddConnectionFormFieldProps extends Omit<InputProps, "onChange"> {
  label: React.ReactNode;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
}

export function AddConnectionFormField({
  label,
  onChange,
  hint,
  className,
  ...inputProps
}: AddConnectionFormFieldProps) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-medium text-text-2">
        {label}
      </label>
      <Input size="small" onChange={onChange} {...inputProps} />
      {hint && <p className="mt-1 text-[10px] text-text-4">{hint}</p>}
    </div>
  );
}
