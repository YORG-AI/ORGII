import { type ReactNode, createContext, useContext } from "react";

export type PropertyDropdownDirection = "up" | "down";

const PropertyDropdownDirectionContext =
  createContext<PropertyDropdownDirection>("down");

export function PropertyDropdownDirectionProvider({
  children,
  direction,
}: {
  children?: ReactNode;
  direction: PropertyDropdownDirection;
}) {
  return (
    <PropertyDropdownDirectionContext.Provider value={direction}>
      {children}
    </PropertyDropdownDirectionContext.Provider>
  );
}

export function usePropertyDropdownDirection(): PropertyDropdownDirection {
  return useContext(PropertyDropdownDirectionContext);
}
