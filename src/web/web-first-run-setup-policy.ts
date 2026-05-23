export function firstRunSetupTokenError(setupToken: string, expectedToken: string | undefined): string | null {
  if (!expectedToken || !setupToken) {
    return "Setup token required.";
  }
  return setupToken === expectedToken ? null : "Invalid setup token.";
}
