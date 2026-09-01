export const GENERIC_SETUP_METHOD = {
  AUTODETECT: "autodetect",
  ENTER_KEY: "enter_key",
  EXTRACT: "extract",
} as const;

export type GenericSetupMethod =
  (typeof GENERIC_SETUP_METHOD)[keyof typeof GENERIC_SETUP_METHOD];

const GENERIC_SETUP_METHODS_DEFAULT: GenericSetupMethod[] = [
  GENERIC_SETUP_METHOD.AUTODETECT,
  GENERIC_SETUP_METHOD.ENTER_KEY,
  GENERIC_SETUP_METHOD.EXTRACT,
];

const GENERIC_SETUP_METHOD_SET = new Set<string>(
  Object.values(GENERIC_SETUP_METHOD)
);

function isGenericSetupMethod(value: string): value is GenericSetupMethod {
  return GENERIC_SETUP_METHOD_SET.has(value);
}

export function resolveGenericSetupMethods(
  supportedMethods: string[] | undefined
): GenericSetupMethod[] {
  if (!supportedMethods || supportedMethods.length === 0) {
    return GENERIC_SETUP_METHODS_DEFAULT;
  }

  const resolved = supportedMethods.filter(isGenericSetupMethod);
  return resolved.length > 0 ? resolved : GENERIC_SETUP_METHODS_DEFAULT;
}

export function resolveActiveSetupMethod(
  setupMethod: GenericSetupMethod,
  allowedMethods: GenericSetupMethod[]
): GenericSetupMethod {
  if (allowedMethods.includes(setupMethod)) {
    return setupMethod;
  }

  return allowedMethods[0] ?? GENERIC_SETUP_METHOD.AUTODETECT;
}
