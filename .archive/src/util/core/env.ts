/**
 * Get application base URL
 * @returns Base URL
 */
export const getBaseUrl = (): string => {
  // Development environment uses localhost:1998
  if (process.env.NODE_ENV === "development") {
    return "http://localhost:1998";
  }

  // Production environment uses relative path
  return window.location.origin;
};
